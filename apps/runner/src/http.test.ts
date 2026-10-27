// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunConfig, RunnerHttpApi } from "@t45/contracts/resources/RunnerVms";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ChatProxy from "./chatProxy.ts";
import * as ChatTable from "./ChatTable.ts";
import * as RunnerHttp from "./http.ts";
import * as Fixture from "./Runner.testkit.ts";

const encodeChat = Schema.encodeSync(Schema.fromJsonString(RunConfig));

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A stand-in for a chat's OpenCode: it records requests and answers every one. */
const openCode = Effect.acquireRelease(
  Effect.callback<{
    readonly url: string;
    readonly seen: Array<Seen>;
    readonly server: NodeHttp.Server;
  }>((resume) => {
    const seen: Array<Seen> = [];
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        seen.push({
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, seen, server }));
    });
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

/**
 * The runner's API and chat proxy over fake sandboxes, as T45 calls them. Every chat's OpenCode
 * answers at `chatUrl`, with the password "vm-secret".
 */
const api = (chatUrl = "http://127.0.0.1:9") => {
  const chats = Fixture.makeFakeChats();
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.merge(HttpApiBuilder.layer(RunnerHttpApi), ChatProxy.layer).pipe(
      Layer.provide(RunnerHttp.layer),
      Layer.provide(RunnerHttp.layerAuth),
      Layer.provide(ChatTable.layer),
      Layer.provide(
        Fixture.layerFakeChats(chats, { url: chatUrl, password: Redacted.make("vm-secret") }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Fixture.layerModels),
      Layer.provide(Fixture.layerConfig()),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
      // Failure cases log warnings on purpose; keep them out of the test output.
      Layer.provideMerge(Logger.layer([])),
    ),
    { disableLogger: true, routerConfig: RunnerHttp.routerConfig },
  );
  const call = (
    path: string,
    init: Omit<RequestInit, "headers"> & { readonly headers?: Record<string, string> } = {},
    token = "secret-token",
    authorization = `Bearer ${token}`,
  ) =>
    Effect.promise(() =>
      handler(
        new Request(`http://runner${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...init.headers, authorization },
        }),
      ),
    );
  return { chats, call, dispose: Effect.promise(dispose) };
};

it.effect("Only T45's token reaches the runner", () =>
  Effect.gen(function* () {
    const runner = api();
    assert.strictEqual((yield* runner.call("/inventory", {}, "wrong")).status, 401);
    assert.strictEqual((yield* runner.call("/inventory")).status, 200);
    yield* runner.dispose;
  }),
);

it.effect("A runner that can't run sandboxes says why in its inventory and refuses VMs", () =>
  Effect.gen(function* () {
    const runner = api();
    const json = (response: Response) => Effect.promise(() => response.json());
    const start = (chatId: string) =>
      runner
        .call(`/chats/${chatId}`, { method: "PUT", body: encodeChat(Fixture.chat()) })
        .pipe(Effect.flatMap(json));
    runner.chats.health = { isAvailable: false, reason: "No KVM on this host." };
    assert.deepStrictEqual(yield* runner.call("/inventory").pipe(Effect.flatMap(json)), {
      isAvailable: false,
      reason: "No KVM on this host.",
      vms: [],
    });
    assert.deepStrictEqual(yield* start("chat-1"), {
      _tag: "RunnerRefusedError",
      reason: "No KVM on this host.",
    });
    runner.chats.health = { isAvailable: false, reason: null };
    assert.deepStrictEqual(yield* start("chat-2"), {
      _tag: "RunnerRefusedError",
      reason: "The runner can't run sandboxes.",
    });
    assert.deepStrictEqual(runner.chats.started, []);
    yield* runner.dispose;
  }),
);

it.effect("A 150-character VM id starts its VM instead of a 404", () =>
  Effect.gen(function* () {
    const runner = api();
    const vmId = "a".repeat(150);
    const response = yield* runner.call(`/chats/${vmId}`, {
      method: "PUT",
      body: encodeChat(Fixture.chat()),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(runner.chats.started, [vmId]);
    yield* runner.dispose;
  }),
);

it.effect("The OpenCode proxy reaches only chats T45 started, with the VM's own password", () =>
  Effect.gen(function* () {
    const target = yield* openCode;
    const runner = api(target.url);
    const basic = (password: string) =>
      `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const info = (password: string) =>
      runner
        .call("/chats/chat-1/opencode/api/info", {}, "", basic(password))
        .pipe(Effect.map((response) => response.status));
    assert.strictEqual(yield* info("secret-token"), 503);
    yield* runner.call("/chats/chat-1", { method: "PUT", body: encodeChat(Fixture.chat()) });
    assert.strictEqual(yield* info("wrong"), 401);
    assert.strictEqual(yield* info("secret-token"), 201);
    assert.strictEqual(target.seen[0]?.authorization, basic("vm-secret"));
    yield* runner.call("/chats/chat-1", { method: "DELETE" });
    assert.strictEqual(yield* info("secret-token"), 503);
    yield* runner.dispose;
  }).pipe(Effect.scoped),
);
