import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { ChatId, Refused as ChatRefused } from "@t45/contracts/models/Chat";
import { type Automation, AutomationId } from "@t45/contracts/models/Automation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { ChatRepository } from "../chats/ChatRepository.ts";
import { addAgent, addUser, layerStore as layerChats } from "../chats/Chats.testkit.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import * as AutomationService from "./AutomationService.ts";
import { renderPrompt, type WebhookRequest } from "./webhook.ts";
import * as WebhookRoute from "./webhookRoute.ts";
import { TaskService } from "../tasks/TaskService.ts";

const AT = "2026-09-09T12:00:00.000Z";
const at = DateTime.makeUnsafe(AT);

const layerStore = AutomationRepository.layer.pipe(Layer.provideMerge(layerChats));

const seed = Effect.gen(function* () {
  yield* addUser("admin", "admin");
  yield* addAgent("Clerk", { chat: false });
  yield* addAgent("Retired", { status: "archived" });
});

const addHook = (id: string, fields: Partial<Automation> = {}) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    yield* automations.insert({
      id: AutomationId.make(id),
      title: `Hook ${id}`,
      prompt: "Review this PR: {{body.pull_request.url}}",
      agentId: "agent-clerk",
      isEnabled: true,
      schedule: { type: "webhook", signature: null },
      webhookToken: `token-${id}`,
      nextRunAt: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
      ...fields,
    });
    return `/api/hooks/${id}/token-${id}`;
  });

const lastError = (id: string) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    return (yield* automations.get(AutomationId.make(id)))?.lastError;
  });

const serve = (options: { readonly start?: TaskService["Service"]["start"] } = {}) =>
  Effect.gen(function* () {
    const posts = yield* TaskService;
    const context = yield* Layer.build(
      AutomationService.layer.pipe(
        Layer.provide(
          Layer.succeed(
            TaskService,
            TaskService.of({ ...posts, start: options.start ?? posts.start }),
          ),
        ),
      ),
    );
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(WebhookRoute.layer, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose),
    );
    const request = (path: string, init: RequestInit = {}) =>
      Effect.promise(() =>
        handler(new Request(`http://127.0.0.1${path}`, { method: "POST", ...init }), context),
      );
    return { request };
  });

const json = (response: Response) => Effect.promise((): Promise<unknown> => response.json());

const decodeAccepted = Schema.decodeUnknownSync(Schema.Struct({ chatId: ChatId }));

const runOf = (response: Response) =>
  Effect.gen(function* () {
    const { chatId } = decodeAccepted(yield* json(response));
    const inputs = yield* (yield* ChatRepository).openInputs(chatId);
    return inputs.map((input) => input.payload.text);
  });

const pullRequest = JSON.stringify({
  pull_request: { url: "https://github.com/org/repo/pull/45" },
});

describe("webhook route", () => {
  it.effect(
    "starts a run for each method and answers 202 with its chat once its input is saved",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const path = yield* addHook("review");
        const { request } = yield* serve();
        for (const method of ["POST", "PUT", "PATCH"]) {
          const response = yield* request(path, {
            method,
            body: pullRequest,
            headers: { "content-type": "application/json" },
          });
          assert.equal(response.status, 202);
          assert.deepEqual(yield* runOf(response), [
            "Review this PR: https://github.com/org/repo/pull/45",
          ]);
        }
        const get = yield* request(path, { method: "GET" });
        assert.equal(get.status, 202);
        assert.deepEqual(yield* runOf(get), ["Review this PR: "]);
        assert.isNull(yield* lastError("review"));
      }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect(
    "answers one 404 for an unknown hook, a wrong token and an automation that isn't a webhook",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* addHook("review");
        const timer = yield* addHook("timer", {
          schedule: { type: "interval", everyMs: 60_000 },
          nextRunAt: DateTime.add(at, { hours: 1 }),
        });
        const { request } = yield* serve();

        for (const path of [
          "/api/hooks/missing/token-missing",
          "/api/hooks/review/token-timer",
          timer,
        ]) {
          const response = yield* request(path, { body: pullRequest });
          assert.equal(response.status, 404);
          assert.deepEqual(yield* json(response), { error: "hook_not_found" });
        }
        assert.equal((yield* request("/api/hooks/review/token-review/extra")).status, 404);
      }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("caps the body at 1 MB, chunked bodies included, before looking up the hook", () =>
    Effect.gen(function* () {
      yield* seed;
      const { request } = yield* serve();
      const unknown = "/api/hooks/missing/token-missing";

      const declared = yield* request(unknown, {
        body: "{}",
        headers: { "content-length": String(WebhookRoute.WEBHOOK_MAX_BODY_BYTES + 1) },
      });
      assert.equal(declared.status, 413);
      assert.deepEqual(yield* json(declared), { error: "body_too_large" });
      const large = yield* request(unknown, {
        body: new Uint8Array(WebhookRoute.WEBHOOK_MAX_BODY_BYTES + 1),
      });
      assert.equal(large.status, 413);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WebhookRoute.WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      // Node's fetch needs duplex for streamed bodies.
      const streamed = yield* request(unknown, { body: chunked, duplex: "half" });
      assert.equal(streamed.status, 413);
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("rate-limits a hook before its enabled and signature checks", () =>
    Effect.gen(function* () {
      yield* seed;
      const paused = yield* addHook("paused", { isEnabled: false });
      const signed = yield* addHook("signed", {
        schedule: {
          type: "webhook",
          signature: { header: "x-signature", encoding: "hex", prefix: "", secret: "s3cret" },
        },
      });
      const { request } = yield* serve();

      for (const [path, status] of [
        [paused, 409],
        [signed, 401],
      ] as const) {
        const statuses = [];
        for (let index = 0; index < 61; index += 1) {
          statuses.push((yield* request(path, { body: pullRequest })).status);
        }
        assert.deepEqual(statuses, [...Array.from({ length: 60 }, () => status), 429]);
      }
      const response = yield* request(paused, { body: pullRequest });
      assert.deepEqual(yield* json(response), { error: "rate_limited" });
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("answers 409 for a paused hook and 401 for a bad signature, hex or base64", () =>
    Effect.gen(function* () {
      yield* seed;
      const paused = yield* addHook("paused", { isEnabled: false });
      const github = yield* addHook("github", {
        schedule: {
          type: "webhook",
          signature: {
            header: "X-Hub-Signature-256",
            encoding: "hex",
            prefix: "sha256=",
            secret: "s3cret",
          },
        },
      });
      const base64 = yield* addHook("base64", {
        schedule: {
          type: "webhook",
          signature: { header: "x-signature", encoding: "base64", prefix: "v1=", secret: "other" },
        },
      });
      const { request } = yield* serve();
      const hmac = (secret: string, body: string) =>
        NodeCrypto.createHmac("sha256", secret).update(body);
      const signedWith = (path: string, header: string, value: string) =>
        request(path, { body: pullRequest, headers: { [header]: value } });

      const pausedResponse = yield* request(paused, { body: pullRequest });
      assert.equal(pausedResponse.status, 409);
      assert.deepEqual(yield* json(pausedResponse), { error: "hook_disabled" });

      const hex = hmac("s3cret", pullRequest).digest("hex");
      const refused = [
        yield* request(github, { body: pullRequest }),
        yield* signedWith(github, "x-hub-signature-256", hex),
        yield* signedWith(
          github,
          "x-hub-signature-256",
          `sha256=${hmac("wrong", pullRequest).digest("hex")}`,
        ),
        yield* signedWith(
          github,
          "x-hub-signature-256",
          `sha256=${hmac("s3cret", "{}").digest("hex")}`,
        ),
        yield* signedWith(base64, "x-signature", hmac("other", pullRequest).digest("base64")),
      ];
      assert.deepEqual(
        refused.map((response) => response.status),
        refused.map(() => 401),
      );
      assert.deepEqual(yield* json(refused[0]!), { error: "invalid_signature" });

      const accepted = [
        yield* signedWith(github, "x-hub-signature-256", `sha256=${hex.toUpperCase()}`),
        yield* signedWith(
          base64,
          "x-signature",
          `v1=${hmac("other", pullRequest).digest("base64")}`,
        ),
      ];
      assert.deepEqual(
        accepted.map((response) => response.status),
        [202, 202],
      );
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("answers 422 for a rendered prompt it can't post, and records why", () =>
    Effect.gen(function* () {
      yield* seed;
      const whole = yield* addHook("whole", { prompt: "{{body}}" });
      const empty = yield* addHook("empty", { prompt: "{{body.missing}}" });
      const retired = yield* addHook("retired", { agentId: "agent-retired" });
      const padded = yield* addHook("padded", { prompt: "{{body.text}}" });
      const { request } = yield* serve();

      const tooLong = yield* request(whole, { body: "x".repeat(200_000) });
      assert.equal(tooLong.status, 422);
      assert.deepEqual(yield* json(tooLong), { error: "prompt_too_long" });
      assert.equal(
        yield* lastError("whole"),
        new ChatRefused({ reason: "input_too_long" }).message,
      );

      const blank = yield* request(empty, { body: pullRequest });
      assert.equal(blank.status, 422);
      assert.deepEqual(yield* json(blank), { error: "prompt_empty" });
      assert.equal(yield* lastError("empty"), new ChatRefused({ reason: "empty_input" }).message);

      const archived = yield* request(retired, { body: pullRequest });
      assert.equal(archived.status, 422);
      assert.deepEqual(yield* json(archived), { error: "agent_unavailable" });
      assert.equal(
        yield* lastError("retired"),
        new ChatRefused({ reason: "agent_unavailable" }).message,
      );

      const text = `{"text":"${" ".repeat(1_000)}${"x".repeat(119_990)}${"\\n".repeat(1_000)}"}`;
      const fits = yield* request(padded, { body: text });
      assert.equal(fits.status, 202);
      assert.deepEqual(
        (yield* runOf(fits)).map((prompt) => prompt.trim().length),
        [119_990],
      );
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("answers a fixed 500 when the post fails", () =>
    Effect.gen(function* () {
      yield* seed;
      const path = yield* addHook("review");
      const { request } = yield* serve({ start: () => Effect.die("the chat store is gone") });

      const response = yield* request(path, { body: pullRequest });
      assert.equal(response.status, 500);
      assert.deepEqual(yield* json(response), { error: "internal_error" });
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("renders the whole request without the token in its path", () =>
    Effect.gen(function* () {
      yield* seed;
      const path = yield* addHook("review", { prompt: "{{request}}" });
      const { request } = yield* serve();

      const response = yield* request(`${path}?source=github`, {
        body: pullRequest,
        headers: { "content-type": "application/json" },
      });
      const [prompt = ""] = yield* runOf(response);
      assert.isTrue(prompt.startsWith("POST /api/hooks/review?source=github\n"));
      assert.notInclude(prompt, "token-review");
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );
});

const githubPullRequest: WebhookRequest = {
  method: "POST",
  path: "/api/hooks/automation-1",
  query: "source=github",
  headers: { "content-type": "application/json", "x-github-event": "pull_request" },
  bodyText: JSON.stringify({
    action: "opened",
    pull_request: { url: "https://github.com/org/repo/pull/45", number: 45, labels: ["bug"] },
  }),
};

describe("renderPrompt", () => {
  it("sends only what the template names", () => {
    assert.equal(
      renderPrompt("Review this PR: {{body.pull_request.url}}", githubPullRequest),
      "Review this PR: https://github.com/org/repo/pull/45",
    );
  });

  it("reads headers case-insensitively, query parameters and array indexes", () => {
    assert.equal(
      renderPrompt(
        "{{ headers.X-GitHub-Event }} #{{body.pull_request.number}} {{body.pull_request.labels.0}} {{query.source}}",
        githubPullRequest,
      ),
      "pull_request #45 bug github",
    );
  });

  it("renders objects as JSON, and the raw body and the request when asked", () => {
    assert.equal(
      renderPrompt("{{body.pull_request.labels}}|{{body}}", githubPullRequest),
      `[\n  "bug"\n]|${githubPullRequest.bodyText}`,
    );
    const request = renderPrompt("{{request}}", githubPullRequest);
    assert.isTrue(request.startsWith("POST /api/hooks/automation-1?source=github\n"));
    assert.include(request, "x-github-event: pull_request");
    assert.isTrue(request.endsWith(githubPullRequest.bodyText));
  });

  it("renders a path with no value empty", () => {
    assert.equal(
      renderPrompt("a={{body.nope}} c={{headers.x-missing}} d={{unknown}}", githubPullRequest),
      "a= c= d=",
    );
  });

  it("addresses form-encoded bodies and leaves other bodies to {{body}}", () => {
    const form = renderPrompt("{{body.text}} by {{body.user_name}}", {
      ...githubPullRequest,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      bodyText: "text=deploy+prod&user_name=alice",
    });
    assert.equal(form, "deploy prod by alice");
    const plain = renderPrompt("{{body.field}}{{body}}", {
      ...githubPullRequest,
      headers: { "content-type": "text/plain" },
      bodyText: "build failed",
    });
    assert.equal(plain, "build failed");
  });

  it("redacts credentials in whole-request placeholders but not named ones", () => {
    const request: WebhookRequest = {
      ...githubPullRequest,
      query: "source=github&access_token=q-secret",
      headers: {
        ...githubPullRequest.headers,
        authorization: "Bearer h-secret",
        "x-hub-signature-256": "sha256=abc",
      },
    };
    const whole = renderPrompt("{{request}}|{{headers}}|{{query}}", request);
    for (const secret of ["q-secret", "h-secret", "sha256=abc"]) {
      assert.notInclude(whole, secret);
    }
    assert.include(whole, "?source=github&access_token=[redacted]\n");
    assert.include(whole, "authorization: [redacted]");
    assert.include(whole, "x-github-event: pull_request");
    assert.equal(
      renderPrompt("{{headers.authorization}} {{query.access_token}}", request),
      "Bearer h-secret q-secret",
    );
  });

  it("does not resolve inherited object properties", () => {
    assert.equal(renderPrompt("{{body.constructor}}{{body.__proto__}}", githubPullRequest), "");
  });
});
