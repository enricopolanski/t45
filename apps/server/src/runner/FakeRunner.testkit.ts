import { RunConfig } from "@t45/contracts/resources/RunnerVms";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

/** Scripted runner HTTP responses and receipts for T45's execution tests. */
export interface FakeRunner {
  /** Set to refuse every VM start with this reason. */
  refuse: string | null;
  /** Each VM start T45 asked for, by chat id, refused ones included. */
  readonly starts: Array<string>;
  /** Set while the runner, and the VMs behind it, can't be reached. */
  down: boolean;
  /** VMs running, by chat id, with what each was started with. */
  readonly chats: Map<string, RunConfig>;
  /** Told of each VM T45 removes, for `removed`. */
  readonly removals: Set<(chatId: string) => void>;
  /** Files put into running VMs, by `<chatId>:<path>`. */
  readonly chatFiles: Map<string, Uint8Array>;
  /** Each running VM's `/work` tarball, as T45 put it back or a test scripts the agent's work. */
  readonly workspaces: Map<string, Uint8Array>;
  /** Where VMs' OpenCode servers answer, such as a local stand-in. */
  chatUrl: string;
}

export const makeFakeRunner = (): FakeRunner => ({
  refuse: null,
  starts: [],
  down: false,
  chats: new Map(),
  removals: new Set(),
  chatFiles: new Map(),
  workspaces: new Map(),
  chatUrl: "http://127.0.0.1:9",
});

/** Back to a fresh, healthy runner with no VMs, for the next test. */
export const reset = (runner: FakeRunner) => {
  Object.assign(runner, makeFakeRunner());
};

/** Waits until the chat has no VM: at once when none runs, otherwise until T45 removes it. */
export const removed = (runner: FakeRunner, chatId: string) =>
  Effect.suspend(() =>
    !runner.chats.has(chatId)
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

const decodeRunConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(RunConfig)),
);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const refused = (reason: string) => json({ _tag: "RunnerRefusedError", reason }, 422);
const noContent = () => new Response(null, { status: 204 });

/** A VM's start or removal leaves nothing of what it held. */
const forget = (runner: FakeRunner, chatId: string) => {
  runner.workspaces.delete(chatId);
  for (const key of runner.chatFiles.keys()) {
    if (key.startsWith(`${chatId}:`)) runner.chatFiles.delete(key);
  }
};

/** Answers one runner request; a VM's start always replaces the VM the chat had. */
export const respond = (
  runner: FakeRunner,
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
) => {
  if (request.headers.authorization !== "Bearer runner-token") {
    throw new Error("The fixture expects T45's runner bearer token.");
  }
  const matched = /^\/chats\/([^/]+)(?:\/(files|workspace))?$/u.exec(url.pathname);
  const chatId = decodeURIComponent(matched?.[1] ?? "");
  const part = matched?.[2];
  const operation =
    matched === null
      ? null
      : part === "files"
        ? request.method === "PUT"
          ? "putChatFile"
          : null
        : part === "workspace"
          ? request.method === "GET"
            ? "getChatWorkspace"
            : request.method === "PUT"
              ? "putChatWorkspace"
              : null
          : request.method === "PUT"
            ? "startChat"
            : request.method === "DELETE"
              ? "removeChat"
              : null;
  if (operation === null) {
    throw new Error(`Unscripted runner request: ${request.method} ${url.pathname}`);
  }
  if (operation === "startChat") runner.starts.push(chatId);
  if (runner.down) return json({ error: "down" }, 503);
  const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
  switch (operation) {
    case "startChat":
      if (runner.refuse !== null) return refused(runner.refuse);
      forget(runner, chatId);
      runner.chats.set(chatId, decodeRunConfig(new TextDecoder().decode(bytes)));
      return noContent();
    case "putChatFile":
      runner.chatFiles.set(`${chatId}:${url.searchParams.get("path")}`, bytes);
      return noContent();
    case "getChatWorkspace":
      return new Response(new Uint8Array(runner.workspaces.get(chatId) ?? []), {
        headers: { "content-type": "application/octet-stream" },
      });
    case "putChatWorkspace":
      runner.workspaces.set(chatId, bytes);
      return noContent();
    case "removeChat":
      runner.chats.delete(chatId);
      forget(runner, chatId);
      for (const told of runner.removals) told(chatId);
      return noContent();
  }
};

/** Points RunnerService at the fake runner. */
export const layer = (runner: FakeRunner) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { RUNNER_URL: runner.chatUrl, RUNNER_TOKEN: "runner-token" },
    }),
  );
