import type { RunConfig, RunnerInventory } from "@t45/contracts/resources/RunnerVms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ChatSandbox, type ChatServer, SandboxError } from "./ChatSandbox.ts";
import { ModelCatalog } from "./ModelCatalog.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

/** VMs in memory: tests see which chats started and were removed. */
interface FakeChats {
  /** Set to stop VMs from running, as on a host without KVM. */
  health: Pick<RunnerInventory, "isAvailable" | "reason">;
  /** Each start is a new boot, `boot-<n>` for the nth start. */
  readonly started: Array<string>;
  /** Files written into chats, by `<chatId>:<path>`. */
  readonly files: Map<string, Uint8Array>;
  /** Each chat's workspace tarball, as it was last unpacked into it. */
  readonly workspaces: Map<string, Uint8Array>;
  readonly removed: Array<string>;
  /** Chats whose VM a test stopped behind the runner's back; starting one clears it. */
  readonly crashed: Set<string>;
  /** Set to fail starts, or removals, as microsandbox can. */
  failStart: boolean;
  failRemove: boolean;
  /** Run by each start after it is counted, so a test can hold a start mid-way. */
  hold: Effect.Effect<void>;
}

export const makeFakeChats = (): FakeChats => ({
  health: { isAvailable: true, reason: null },
  started: [],
  files: new Map(),
  workspaces: new Map(),
  removed: [],
  crashed: new Set(),
  failStart: false,
  failRemove: false,
  hold: Effect.void,
});

const failure = (operation: string) =>
  new SandboxError({ operation, cause: new Error(`${operation} failed`) });

/** Every chat's server is `server`, such as a local stand-in for OpenCode. */
export const layerFakeChats = (
  chats: FakeChats,
  server: Omit<ChatServer, "bootId"> = {
    url: "http://127.0.0.1:9",
    password: Redacted.make("vm-password"),
  },
) => {
  /** Which chat each boot is. */
  const boots = new Map<string, string>();
  return Layer.succeed(
    ChatSandbox,
    ChatSandbox.of({
      health: Effect.sync(() => chats.health),
      start: ({ chatId }) =>
        Effect.gen(function* () {
          chats.started.push(chatId);
          const bootId = `boot-${chats.started.length}`;
          yield* chats.hold;
          if (chats.failStart) return yield* failure("start");
          chats.crashed.delete(chatId);
          boots.set(bootId, chatId);
          return { ...server, bootId };
        }),
      write: ({ chatId, path, content }) =>
        Effect.sync(() => void chats.files.set(`${chatId}:${path}`, content)),
      packWorkspace: (chatId) =>
        Effect.sync(() => chats.workspaces.get(chatId) ?? new Uint8Array()),
      unpackWorkspace: ({ chatId, content }) =>
        Effect.sync(() => void chats.workspaces.set(chatId, content)),
      serving: ({ bootId }) => Effect.sync(() => !chats.crashed.has(boots.get(bootId) ?? "")),
      remove: (chatId) =>
        chats.failRemove
          ? Effect.fail(failure("remove"))
          : Effect.sync(() => void chats.removed.push(chatId)),
      sweep: Effect.void,
    }),
  );
};

/** A chat whose agent has only instructions. */
export const chat = (): RunConfig => ({
  agent: {
    instructions: "Be brief.",
    files: {},
    skills: {},
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

export const layerConfig = (overrides: Partial<RunnerConfig["Service"]> = {}) =>
  Layer.succeed(
    RunnerConfig,
    RunnerConfig.of({
      host: "127.0.0.1",
      port: 0,
      token: Redacted.make("secret-token"),
      image: "t45-agent:test",
      ipv4Pool: "10.200.0.0/16",
      denyIps: [],
      openCodeKey: Redacted.make("sk-test"),
      ...overrides,
    }),
  );
