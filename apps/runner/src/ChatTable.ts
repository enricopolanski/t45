/*
 * The runner's chat VMs, in memory. T45 starts a VM before it talks to it and learns which boot of
 * it runs; the runner then counts the requests T45 has open to the VM's OpenCode, its event stream
 * among them. A VM keeps nothing: T45 removes it when it's done with it, and the runner removes
 * one nothing has been open to for the idle time, as when T45 lost it. A VM that stopped on its
 * own, or whose OpenCode stopped answering, starts again as a new VM at the next start.
 */
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import {
  type RunnerInventory,
  type RunConfig,
  RunnerRefusedError,
} from "@t45/contracts/resources/RunnerVms";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ChatSandbox, type ChatServer, type SandboxError } from "./ChatSandbox.ts";

/**
 * How long a VM with nothing open to it keeps running. T45 holds a VM open while it follows it and
 * removes a chat's itself when the chat sleeps, so this outlasts a T45 restart and lets go of a VM
 * T45 lost for good.
 */
const IDLE_MILLIS = 45 * 60 * 1000;

interface Chat {
  readonly chatId: string;
  readonly lock: Semaphore.Semaphore;
  /** Booting, serving, or stopped and gone. */
  state: "starting" | "running" | "stopped";
  /** The running boot's server. */
  server: ChatServer | null;
  connections: number;
  lastActiveAt: number;
}

export class ChatTable extends Context.Service<
  ChatTable,
  {
    /**
     * Starts the VM unless it runs and answers, and says which boot of it runs; refuses with a
     * reason.
     */
    readonly ensure: (input: {
      readonly chatId: string;
      readonly chat: RunConfig;
    }) => Effect.Effect<{ readonly bootId: string }, RunnerRefusedError>;
    /** The running chat's server, counted as in use until the scope closes; none when it isn't running. */
    readonly connect: (
      chatId: string,
    ) => Effect.Effect<Option.Option<ChatServer>, never, Scope.Scope>;
    /**
     * Puts a file in the running chat's VM; refuses one too large, one at any path but a stored
     * attachment's under `attachments/`, and when the chat doesn't run.
     */
    readonly writeFile: (input: {
      readonly chatId: string;
      readonly path: string;
      readonly content: Uint8Array;
    }) => Effect.Effect<void, RunnerRefusedError>;
    /** The running chat's workspace as a gzipped tarball. */
    readonly readWorkspace: (chatId: string) => Effect.Effect<Uint8Array, RunnerRefusedError>;
    /** Unpacks a workspace tarball into the running chat's VM. */
    readonly writeWorkspace: (input: {
      readonly chatId: string;
      readonly content: Uint8Array;
    }) => Effect.Effect<void, RunnerRefusedError>;
    /**
     * Stops the VM and deletes it with its disk; fails when it could not, so T45 tries again, and
     * keeps it listed as stopped until then.
     */
    readonly remove: (chatId: string) => Effect.Effect<void, SandboxError>;
    readonly inventory: Effect.Effect<RunnerInventory>;
    /** Lets go of VMs nothing has been open to for the idle time. */
    readonly stopIdle: Effect.Effect<void>;
  }
>()("@t45/runner/ChatTable") {}

const ATTACHMENT_PATH = /^attachments\/[0-9a-f-]{36}\.[a-z0-9]{1,10}$/u;

/** Refuses with `reason` when the sandbox fails, logging why as `what`. */
const refuseOnSandboxError =
  (what: string, reason: string) =>
  <A>(effect: Effect.Effect<A, SandboxError>) =>
    effect.pipe(
      Effect.tapError((error) => Effect.logWarning(what, error)),
      Effect.mapError(() => new RunnerRefusedError({ reason })),
    );

const make = Effect.gen(function* () {
  const sandboxes = yield* ChatSandbox;
  const chats = new Map<string, Chat>();

  const entryFor = Effect.fn("ChatTable.entryFor")(function* (chatId: string) {
    const existing = chats.get(chatId);
    if (existing !== undefined) return existing;
    const entry: Chat = {
      chatId,
      lock: yield* Semaphore.make(1),
      state: "stopped",
      server: null,
      connections: 0,
      lastActiveAt: yield* Clock.currentTimeMillis,
    };
    chats.set(chatId, entry);
    return entry;
  });

  /** The running chat's entry, touched as in use; refused when it isn't running. */
  const runningEntry = (chatId: string) =>
    Effect.gen(function* () {
      const entry = chats.get(chatId);
      if (entry === undefined || entry.state !== "running") {
        return yield* new RunnerRefusedError({ reason: "The chat isn't running." });
      }
      entry.lastActiveAt = yield* Clock.currentTimeMillis;
      return entry;
    });

  /** Lets go of the entry's VM, removing it, since it keeps nothing. */
  const release = (entry: Chat) =>
    Effect.suspend(() => {
      entry.state = "stopped";
      entry.server = null;
      return sandboxes.remove(entry.chatId).pipe(
        Effect.catchTags({
          SandboxError: (error) => Effect.logWarning("Letting a VM go failed", error),
        }),
      );
    });

  const idle = (entry: Chat, now: number) =>
    entry.state === "running" && entry.connections === 0 && now - entry.lastActiveAt >= IDLE_MILLIS;

  return ChatTable.of({
    inventory: Effect.map(sandboxes.health, (health) => ({
      ...health,
      vms: [...chats.values()].map(({ chatId, state, connections, lastActiveAt }) => ({
        vmId: chatId,
        state,
        connections,
        lastActiveAt: DateTime.makeUnsafe(lastActiveAt),
      })),
    })),
    ensure: ({ chatId, chat }) =>
      Effect.gen(function* () {
        const entry = yield* entryFor(chatId);
        return yield* entry.lock.withPermit(
          Effect.gen(function* () {
            entry.lastActiveAt = yield* Clock.currentTimeMillis;
            if (entry.state === "running" && entry.server !== null) {
              if (yield* sandboxes.serving(entry.server)) return { bootId: entry.server.bootId };
              yield* Effect.logWarning("A VM stopped answering; starting it again", { chatId });
              yield* release(entry);
            }
            // The start finishes even when T45 drops the request, so the VM it makes stays known
            // and is let go when idle; one that fails to start is let go at once, since it may be
            // booted.
            const server = yield* Effect.sync(() => (entry.state = "starting")).pipe(
              Effect.andThen(sandboxes.start({ chatId, chat })),
              Effect.tap((server) =>
                Effect.sync(() => {
                  entry.server = server;
                  entry.state = "running";
                }),
              ),
              Effect.tapError(() => release(entry)),
              Effect.uninterruptible,
              refuseOnSandboxError(
                "Starting a chat's VM failed",
                "The chat's sandbox could not start.",
              ),
            );
            entry.lastActiveAt = yield* Clock.currentTimeMillis;
            return { bootId: server.bootId };
          }),
        );
      }),
    connect: (chatId) =>
      Effect.gen(function* () {
        const entry = chats.get(chatId);
        if (entry === undefined || entry.state !== "running" || entry.server === null) {
          return Option.none();
        }
        const server = entry.server;
        const touch = (by: number) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              entry.connections += by;
              entry.lastActiveAt = now;
            }),
          );
        yield* Effect.acquireRelease(touch(1), () => touch(-1));
        return Option.some(server);
      }),
    writeFile: ({ chatId, path, content }) =>
      Effect.gen(function* () {
        if (content.byteLength > ATTACHMENT_MAX_FILE_BYTES) {
          return yield* new RunnerRefusedError({ reason: "The file is too large." });
        }
        if (!ATTACHMENT_PATH.test(path)) {
          return yield* new RunnerRefusedError({ reason: "Files go only under attachments/." });
        }
        yield* runningEntry(chatId);
        yield* sandboxes
          .write({ chatId, path, content })
          .pipe(
            refuseOnSandboxError(
              "Writing a file into a chat's VM failed",
              "The file could not be added.",
            ),
          );
      }),
    readWorkspace: (chatId) =>
      Effect.gen(function* () {
        yield* runningEntry(chatId);
        return yield* sandboxes
          .packWorkspace(chatId)
          .pipe(
            refuseOnSandboxError(
              "Packing a chat's workspace failed",
              "The workspace could not be saved.",
            ),
          );
      }),
    writeWorkspace: ({ chatId, content }) =>
      Effect.gen(function* () {
        yield* runningEntry(chatId);
        yield* sandboxes
          .unpackWorkspace({ chatId, content })
          .pipe(
            refuseOnSandboxError(
              "Unpacking a chat's workspace failed",
              "The workspace could not be restored.",
            ),
          );
      }),
    remove: (chatId) =>
      Effect.gen(function* () {
        const entry = chats.get(chatId);
        const remove = sandboxes
          .remove(chatId)
          .pipe(
            Effect.tapError((error) => Effect.logWarning("Removing a chat's VM failed", error)),
          );
        if (entry === undefined) return yield* remove;
        yield* entry.lock.withPermit(
          Effect.gen(function* () {
            entry.state = "stopped";
            entry.server = null;
            // Forgotten only once gone, so a VM that outlived a failed remove stays listed.
            yield* remove;
            chats.delete(chatId);
          }),
        );
      }),
    stopIdle: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const entry of chats.values()) {
        if (!idle(entry, now)) continue;
        yield* entry.lock.withPermit(
          Effect.gen(function* () {
            if (idle(entry, yield* Clock.currentTimeMillis)) yield* release(entry);
          }),
        );
      }
    }),
  });
});

export const layer = Layer.effect(ChatTable, make);
