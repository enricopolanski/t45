import type { RunConfig } from "@t45/contracts/resources/RunnerVms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ChatSandbox, type ChatServer, SandboxError } from "./ChatSandbox.ts";
import { ModelCatalog } from "./ModelCatalog.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

/** VMs in memory: tests see which chats started and which VMs exist. */
interface FakeChats {
  /** Each start is a new VM. */
  readonly started: Array<string>;
  /** The chats whose VM exists: booted, even when its start then failed, and not yet removed. */
  readonly vms: Set<string>;
  /** Files written into chats, by `<chatId>:<path>`. */
  readonly files: Map<string, Uint8Array>;
  /** Each chat's workspace tarball, as it was last unpacked into it. */
  readonly workspaces: Map<string, Uint8Array>;
  /** Set to fail starts, or removals, as microsandbox can. */
  failStart: boolean;
  failRemove: boolean;
  /** Run by each start after it is counted, so a test can hold a start mid-way. */
  hold: Effect.Effect<void>;
}

export const makeFakeChats = (): FakeChats => ({
  started: [],
  vms: new Set(),
  files: new Map(),
  workspaces: new Map(),
  failStart: false,
  failRemove: false,
  hold: Effect.void,
});

const failure = (operation: string) =>
  new SandboxError({ operation, cause: new Error(`${operation} failed`) });

/** As in the runner, only a VM that is up takes files and gives or takes its workspace. */
const held = <A>(chats: FakeChats, chatId: string, operation: string, use: () => A) =>
  chats.vms.has(chatId) ? Effect.sync(use) : Effect.fail(failure(operation));

/** Every chat's server is `server`, such as a local stand-in for OpenCode. */
export const layerFakeChats = (
  chats: FakeChats,
  server: ChatServer = { url: "http://127.0.0.1:9", password: Redacted.make("vm-password") },
) =>
  Layer.succeed(
    ChatSandbox,
    ChatSandbox.of({
      start: ({ chatId }) =>
        Effect.gen(function* () {
          chats.started.push(chatId);
          yield* chats.hold;
          chats.vms.add(chatId);
          if (chats.failStart) return yield* failure("start");
          return server;
        }),
      write: ({ chatId, path, content }) =>
        held(chats, chatId, "write", () => void chats.files.set(`${chatId}:${path}`, content)),
      packWorkspace: (chatId) =>
        held(chats, chatId, "pack", () => chats.workspaces.get(chatId) ?? new Uint8Array()),
      unpackWorkspace: ({ chatId, content }) =>
        held(chats, chatId, "unpack", () => void chats.workspaces.set(chatId, content)),
      remove: (chatId) =>
        chats.failRemove
          ? Effect.fail(failure("remove"))
          : Effect.sync(() => void chats.vms.delete(chatId)),
    }),
  );

/** A chat whose agent has only instructions. */
export const chat = (): RunConfig => ({
  agent: {
    instructions: "Be brief.",
    files: {},
    skills: [],
    mcpServers: {},
    permissions: { network: "provider" },
  },
});

/** The models the fake runner offers. */
export const layerModels = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    models: Effect.succeed([{ slug: "opencode-go/glm-5.3", name: "glm-5.3" }]),
  }),
);

export const layerConfig = Layer.succeed(
  RunnerConfig,
  RunnerConfig.of({
    host: "127.0.0.1",
    port: 0,
    token: Redacted.make("secret-token"),
    image: "t45-agent:test",
    ipv4Pool: "10.200.0.0/16",
    denyIps: [],
    openCodeKey: Redacted.make("sk-test"),
  }),
);
