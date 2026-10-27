// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type Attachment, type ChatAttachment } from "@t45/contracts/models/Attachment";
import { ATTACHMENT_ROUTE_PREFIX } from "@t45/contracts/resources/Attachments";
import { AuthSessionId } from "@t45/contracts/resources/Session";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import { ChatService } from "../chats/ChatService.ts";
import * as WorkflowService from "../workflows/WorkflowService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { UserService } from "../org/UserService.ts";
import { SessionInvalidError } from "../auth/Authentication.ts";
import * as Fixture from "../chats/Chats.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as AttachmentRepository from "./AttachmentRepository.ts";
import * as Attachments from "./Attachments.testkit.ts";
import * as AttachmentsHttp from "./http.ts";
import { attachmentResponseHeaders, downloadContentDisposition } from "./http.ts";

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

const download = (mimeType: string) =>
  attachmentResponseHeaders({
    id: "00000000-0000-4000-8000-000000000001.pdf",
    name: "Q3 report.pdf",
    mimeType,
  });

const sentFile = (file: Attachment): ChatAttachment => ({
  type: "file",
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
});

describe("attachmentResponseHeaders", () => {
  it("does not apply document policy to inline images", () => {
    expect(
      attachmentResponseHeaders({
        id: "00000000-0000-4000-8000-000000000002.png",
        name: "diagram.png",
        mimeType: "image/png",
      }),
    ).toEqual({
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("downloads other files under their name and mime type without executing them", () => {
    expect(download("application/pdf")).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(download(mimeType)).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });

  it("preserves official Office Open XML mime types", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(download(mimeType)).toHaveProperty("Content-Type", mimeType);
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});

describe("attachment routes", () => {
  // The session cookie names whether the test session is an approved member or awaits approval.
  const layerAuth = Layer.mock(UserService)({
    publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
    cookieName: "session",
    authenticate: (token) =>
      ["member", "pending", "other", "admin"].includes(token)
        ? Effect.succeed({
            avatar: { kind: "initial", color: "slate" },

            sessionId: AuthSessionId.make("session-1"),
            userId: token === "other" ? "user-2" : token === "admin" ? "admin01" : "user-1",
            role: token === "admin" ? "admin" : "member",
            state: token === "pending" ? "pending" : "active",
            expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
          })
        : Effect.fail(new SessionInvalidError({})),
  });
  const layerContext = layerAuth.pipe(
    Layer.provideMerge(
      WorkflowService.layer.pipe(
        Layer.provideMerge(Fixture.layerBase),
        Layer.tap((context) =>
          Context.get(context, ChatService).start(
            Context.get(context, WorkflowService.WorkflowService).taskHooks,
          ),
        ),
      ),
    ),
    Layer.provideMerge(layerFileResponse),
    Layer.provide(Layer.succeed(ServerActivation, Effect.never)),
  );

  type RequestOptions = { method?: string; body?: string; session?: string };

  const withSeededRoutes = <S, E, A>(
    seed: Effect.Effect<S, E, Layer.Success<typeof layerContext>>,
    use: (input: {
      readonly attachmentsDir: string;
      readonly seeded: S;
      readonly request: (path: string, init?: RequestOptions) => Promise<Response>;
    }) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      // Route handlers read these per request, like the server provides them.
      const requestContext = yield* Layer.build(layerContext);
      const { attachmentsDir } = Context.get(requestContext, ServerConfig.ServerConfig);
      const seeded = yield* seed.pipe(Effect.provideContext(requestContext));
      const layerApp = Layer.mergeAll(
        AttachmentsHttp.layerAttachmentRoute,
        AttachmentsHttp.layerAttachmentUploadRoute,
      ).pipe(Layer.provide(layerFileResponse));
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerApp, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(() =>
            use({
              attachmentsDir,
              seeded,
              request: (path, { session, ...init }: RequestOptions = {}) =>
                handler(
                  new Request(`http://127.0.0.1${path}`, {
                    ...init,
                    headers: {
                      ...(session ? { cookie: `session=${session}` } : {}),
                      // Browsers send the length of a file body; a web Request leaves it out.
                      ...(typeof init.body === "string"
                        ? { "content-length": String(new TextEncoder().encode(init.body).length) }
                        : {}),
                    },
                  }),
                  requestContext,
                ),
            }),
          ),
        ({ dispose }) => Effect.promise(dispose),
      );
    }).pipe(Effect.scoped);

  const withRoutes = <A>(
    use: (input: {
      readonly attachmentsDir: string;
      readonly request: (path: string, init?: RequestOptions) => Promise<Response>;
    }) => Promise<A>,
  ) => withSeededRoutes(Effect.void, use);

  const upload = (type: "image" | "file", name: string, mimeType: string) =>
    `${ATTACHMENT_ROUTE_PREFIX}?${new URLSearchParams({ type, name, mimeType })}`;

  it.effect("stores an upload and serves it back to a member", () =>
    withRoutes(async ({ request }) => {
      const uploaded = await request(upload("file", "notes.txt", "text/plain"), {
        method: "POST",
        session: "member",
        body: "hello",
      });
      expect(uploaded.status).toBe(201);
      const { attachmentId } = (await uploaded.json()) as { attachmentId: string };
      expect(attachmentId).toMatch(/^[0-9a-f-]{36}\.txt$/);

      const fetched = await request(`${ATTACHMENT_ROUTE_PREFIX}/${attachmentId}/notes.txt`, {
        session: "member",
      });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-type")).toBe("text/plain");
      expect(fetched.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
      expect(await fetched.text()).toBe("hello");

      const head = await request(`${ATTACHMENT_ROUTE_PREFIX}/${attachmentId}/notes.txt`, {
        method: "HEAD",
        session: "member",
      });
      expect(head.status).toBe(200);
    }),
  );

  it.effect("keeps an upload private from other members and administrators even with its URL", () =>
    withRoutes(async ({ request }) => {
      const uploaded = await request(upload("file", "private.txt", "text/plain"), {
        method: "POST",
        session: "member",
        body: "private",
      });
      const { attachmentId } = (await uploaded.json()) as { attachmentId: string };
      const path = `${ATTACHMENT_ROUTE_PREFIX}/${attachmentId}/private.txt`;
      expect((await request(path, { session: "other" })).status).toBe(404);
      expect((await request(path, { session: "admin" })).status).toBe(404);
      expect(await (await request(path, { session: "member" })).text()).toBe("private");
    }),
  );

  it.effect("serves a file sent to a chat to whoever may open the chat", () =>
    withSeededRoutes(
      Effect.gen(function* () {
        yield* Fixture.addUser("user-1");
        const agentId = yield* Fixture.addAgent("Clerk");
        const chatId = yield* Fixture.seedChat({
          id: Fixture.testChatId(1),
          ownerUserId: "user-1",
          agentId,
        });
        const files = yield* AttachmentRepository.AttachmentRepository;
        const sent = yield* files.store({
          name: "notes.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("hello"),
          uploader: "user-1",
        });
        yield* files.bindToChat(chatId, [sentFile(sent)], "user-1");
        return sent;
      }),
      async ({ request, seeded }) => {
        const path = `${ATTACHMENT_ROUTE_PREFIX}/${seeded.id}/notes.txt`;
        expect(await (await request(path, { session: "member" })).text()).toBe("hello");
        expect((await request(path, { session: "other" })).status).toBe(404);
        expect((await request(path, { session: "admin" })).status).toBe(404);
      },
    ),
  );

  it.effect(
    "serves a step's file sent to an automation chat to admins, and to its ticket's people",
    () =>
      withSeededRoutes(
        Effect.gen(function* () {
          yield* Fixture.addUser("admin01", "admin");
          const member = yield* Fixture.addUser("user-1");
          const step = yield* Attachments.seedStep("ticket-1", member);
          const files = yield* AttachmentRepository.AttachmentRepository;
          const stored = yield* files.store({
            name: "w2.pdf",
            mimeType: "application/pdf",
            bytes: new TextEncoder().encode("w2"),
            uploader: member,
          });
          const claimed = yield* files.claimForStep({
            id: stored.id,
            actor: member,
            ...step,
            fieldKey: null,
          });
          if (claimed === null) return yield* Effect.die("The step did not take its file.");
          const chatId = yield* Fixture.seedChat({
            id: Fixture.testChatId(1),
            ownerUserId: null,
            agentId: yield* Fixture.addAgent("Clerk"),
            stepId: step.stepId,
          });
          yield* files.bindToChat(chatId, [sentFile(claimed)], null);
          return claimed;
        }),
        async ({ request, seeded }) => {
          const path = `${ATTACHMENT_ROUTE_PREFIX}/${seeded.id}/w2.pdf`;
          expect(await (await request(path, { session: "admin" })).text()).toBe("w2");
          expect(await (await request(path, { session: "member" })).text()).toBe("w2");
          expect((await request(path, { session: "other" })).status).toBe(404);
        },
      ),
  );

  it.effect("refuses requests without a session or from a registration awaiting approval", () =>
    withRoutes(async ({ attachmentsDir, request }) => {
      const attachmentId = "00000000-0000-4000-8000-000000000001.png";
      await NodeFSP.mkdir(attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(attachmentsDir, attachmentId), "png");

      const anonymousRead = await request(`${ATTACHMENT_ROUTE_PREFIX}/${attachmentId}/a.png`);
      expect(anonymousRead.status).toBe(401);
      expect(await anonymousRead.json()).toEqual({ error: "unauthenticated" });
      const anonymousUpload = await request(upload("image", "a.png", "image/png"), {
        method: "POST",
        body: "png",
      });
      expect(anonymousUpload.status).toBe(401);
      expect(await anonymousUpload.json()).toEqual({ error: "unauthenticated" });
      const pendingRead = await request(`${ATTACHMENT_ROUTE_PREFIX}/${attachmentId}/a.png`, {
        session: "pending",
      });
      expect(pendingRead.status).toBe(403);
      expect(await pendingRead.json()).toEqual({ error: "inactive" });
      const pendingUpload = await request(upload("image", "a.png", "image/png"), {
        method: "POST",
        session: "pending",
        body: "png",
      });
      expect(pendingUpload.status).toBe(403);
      expect(await pendingUpload.json()).toEqual({ error: "inactive" });
      expect(await NodeFSP.readdir(attachmentsDir)).toEqual([attachmentId]);
    }),
  );

  it.effect("answers 404 for attachments that do not exist", () =>
    withRoutes(async ({ request }) => {
      const missing = await request(
        `${ATTACHMENT_ROUTE_PREFIX}/00000000-0000-4000-8000-000000000009.png/a.png`,
        { method: "HEAD", session: "member" },
      );
      expect(missing.status).toBe(404);
    }),
  );

  it.effect("rejects uploads outside the attachment limits", () =>
    withRoutes(async ({ request }) => {
      const unsupportedImage = await request(upload("image", "diagram.svg", "image/svg+xml"), {
        method: "POST",
        session: "member",
        body: "<svg/>",
      });
      expect(unsupportedImage.status).toBe(400);
      const empty = await request(upload("file", "empty.txt", "text/plain"), {
        method: "POST",
        session: "member",
        body: "",
      });
      expect(empty.status).toBe(400);
    }),
  );
});
