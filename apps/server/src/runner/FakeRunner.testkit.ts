import { RunConfig, RunnerInventory } from "@t45/contracts/resources/RunnerVms";
import * as Effect from "effect/Effect";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Schema from "effect/Schema";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

/** Scripted runner HTTP responses and receipts for T45's execution tests. */
export interface FakeRunner {
  inventory: RunnerInventory;
  /** The models it offers agents. */
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  /** Set to refuse every VM start with this reason. */
  refuse: string | null;
  /** Each VM start T45 asked for, by chat id, refused ones included. */
  readonly starts: Array<string>;
  /** Set while the runner is unreachable. */
  down: boolean;
  /** Operations that find the runner unreachable while they are listed. */
  readonly downFor: Set<string>;
  /** VMs running, by chat id, with what each was started with. */
  readonly chats: Map<string, RunConfig>;
  /** The boot of each running VM; removing a VM makes its next start a new boot. */
  readonly boots: Map<string, string>;
  /** Each VM's workspace tarball, as T45 put it or a test scripts it. */
  readonly workspaces: Map<string, Uint8Array>;
  /** Set to refuse every workspace read with this reason, as when packing it fails. */
  refuseWorkspace: string | null;
  /** Set to refuse every workspace put with this reason, as when unpacking it fails. */
  refuseUnpack: string | null;
  readonly removedChats: Array<string>;
  holdRemove: Effect.Effect<void> | null;
  /** Told of each VM T45 removes, for `removed`. */
  readonly removals: Set<(chatId: string) => void>;
  /** Files put into VMs, by `<chatId>:<path>`. */
  readonly chatFiles: Map<string, Uint8Array>;
  /** Where VMs' OpenCode servers answer, such as a local stand-in. */
  chatUrl: string;
}

export const makeFakeRunner = (): FakeRunner => ({
  inventory: { isAvailable: true, reason: null, vms: [] },
  models: [{ slug: "opencode-go/test-model", name: "test-model" }],
  refuse: null,
  starts: [],
  down: false,
  downFor: new Set(),
  chats: new Map(),
  boots: new Map(),
  workspaces: new Map(),
  refuseWorkspace: null,
  refuseUnpack: null,
  removedChats: [],
  holdRemove: null,
  removals: new Set(),
  chatFiles: new Map(),
  chatUrl: "http://127.0.0.1:9",
});

/** Back to a fresh, healthy runner with no VMs, for the next test. */
export const reset = (runner: FakeRunner) => {
  Object.assign(runner, makeFakeRunner());
};

/** Waits until T45 has removed the VM `chatId`, as when its chat went to sleep. */
export const removed = (runner: FakeRunner, chatId: string) =>
  Effect.suspend(() =>
    runner.removedChats.includes(chatId)
      ? Effect.void
      : Effect.callback<void>((resume) => {
          const told = (removed: string) => {
            if (removed !== chatId) return;
            runner.removals.delete(told);
            resume(Effect.void);
          };
          runner.removals.add(told);
          return Effect.sync(() => runner.removals.delete(told));
        }),
  );

const encodeInventory = Schema.encodeSync(Schema.toCodecJson(RunnerInventory));
const decodeRunConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(RunConfig)),
);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const refused = (reason: string) => json({ _tag: "RunnerRefusedError", reason }, 422);

/** The existing fake runner's HTTP endpoint. */
export const respond = (
  runner: FakeRunner,
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const matched = /^\/chats\/([^/]+)(?:\/(workspace|files))?$/u.exec(url.pathname);
    const chatId = decodeURIComponent(matched?.[1] ?? "");
    const part = matched?.[2];
    const operation =
      request.method === "GET" && url.pathname === "/inventory"
        ? "inventory"
        : request.method === "GET" && url.pathname === "/models"
          ? "models"
          : part === "workspace" && request.method === "GET"
            ? "getChatWorkspace"
            : part === "workspace" && request.method === "PUT"
              ? "putChatWorkspace"
              : part === "files" && request.method === "PUT"
                ? "putChatFile"
                : matched !== null && part === undefined && request.method === "DELETE"
                  ? "removeChat"
                  : matched !== null && part === undefined && request.method === "PUT"
                    ? "ensureChat"
                    : null;
    if (operation === null)
      throw new Error(`Unscripted runner request: ${request.method} ${url.pathname}`);
    if (request.headers.authorization !== "Bearer runner-token") {
      throw new Error("The fixture expects T45's runner bearer token.");
    }
    if (operation === "ensureChat") runner.starts.push(chatId);
    if (runner.down || runner.downFor.has(operation)) return json({ error: "down" }, 503);
    if ((part === "workspace" || part === "files") && !runner.boots.has(chatId)) {
      return refused("The chat's sandbox isn't running.");
    }
    const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
    switch (operation) {
      case "inventory":
        return json(encodeInventory(runner.inventory));
      case "models":
        return json({ models: runner.models });
      case "ensureChat": {
        if (runner.refuse !== null) return refused(runner.refuse);
        if (!runner.chats.has(chatId)) {
          runner.boots.set(chatId, `boot-${chatId}-${runner.starts.length}`);
          runner.chats.set(chatId, decodeRunConfig(new TextDecoder().decode(bytes)));
        }
        return json({ bootId: runner.boots.get(chatId)! });
      }
      case "getChatWorkspace":
        return runner.refuseWorkspace !== null
          ? refused(runner.refuseWorkspace)
          : new Response(new Uint8Array(runner.workspaces.get(chatId) ?? []), {
              headers: { "content-type": "application/octet-stream" },
            });
      case "putChatWorkspace":
        if (runner.refuseUnpack !== null) return refused(runner.refuseUnpack);
        runner.workspaces.set(chatId, bytes);
        return new Response(null, { status: 204 });
      case "putChatFile":
        runner.chatFiles.set(`${chatId}:${url.searchParams.get("path")}`, bytes);
        return new Response(null, { status: 204 });
      case "removeChat": {
        const held = runner.holdRemove;
        runner.holdRemove = null;
        if (held !== null) yield* held;
        runner.removedChats.push(chatId);
        runner.chats.delete(chatId);
        runner.boots.delete(chatId);
        runner.workspaces.delete(chatId);
        for (const key of runner.chatFiles.keys()) {
          if (key.startsWith(`${chatId}:`)) runner.chatFiles.delete(key);
        }
        for (const told of runner.removals) told(chatId);
        return new Response(null, { status: 204 });
      }
    }
  });

/** Points RunnerService at the existing fake HTTP endpoint. */
export const layer = (runner: FakeRunner) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { RUNNER_URL: runner.chatUrl, RUNNER_TOKEN: "runner-token" },
    }),
  );
