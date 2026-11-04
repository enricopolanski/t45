/*
 * The runner's chat VMs, in memory. T45 starts a new VM for every execution of a chat and removes
 * it when the execution ends; the runner removes VMs only when T45 asks. T45 saves the VM's /work
 * when the execution finishes and puts it back at the next execution's start.
 */
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { type RunConfig, RunnerRefusedError } from "@t45/contracts/resources/RunnerVms";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { ChatSandbox, type ChatServer, type SandboxError } from "./ChatSandbox.ts";

interface Chat {
  readonly chatId: string;
  readonly lock: Semaphore.Semaphore;
  /** Booting, serving, or stopped and gone. */
  state: "starting" | "running" | "stopped";
  /** The running VM's server. */
  server: ChatServer | null;
}

export class ChatTable extends Context.Service<
  ChatTable,
  {
    /** Starts a new VM for the chat, replacing any left of it; refuses with a reason. */
    readonly start: (input: {
      readonly chatId: string;
      readonly chat: RunConfig;
    }) => Effect.Effect<void, RunnerRefusedError>;
    /** The running chat's server; none when it isn't running. */
    readonly server: (chatId: string) => Effect.Effect<Option.Option<ChatServer>>;
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
    /** Stops the VM and deletes it with its disk; fails when it could not. */
    readonly remove: (chatId: string) => Effect.Effect<void, SandboxError>;
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
    };
    chats.set(chatId, entry);
    return entry;
  });

  /** The running chat's entry; refused when it isn't running. */
  const runningEntry = (chatId: string) =>
    Effect.gen(function* () {
      const entry = chats.get(chatId);
      if (entry === undefined || entry.state !== "running") {
        return yield* new RunnerRefusedError({ reason: "The chat isn't running." });
      }
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

  return ChatTable.of({
    start: ({ chatId, chat }) =>
      Effect.gen(function* () {
        const entry = yield* entryFor(chatId);
        // The start finishes even when T45 drops the request, so a remove T45 sends next waits for
        // it and removes the VM it made; one that fails to start is let go at once, since it may be
        // booted.
        yield* entry.lock.withPermit(
          Effect.sync(() => {
            entry.state = "starting";
            entry.server = null;
          }).pipe(
            Effect.andThen(sandboxes.start({ chatId, chat })),
            Effect.map((server) => {
              entry.server = server;
              entry.state = "running";
            }),
            Effect.tapError(() => release(entry)),
            Effect.uninterruptible,
            refuseOnSandboxError(
              "Starting a chat's VM failed",
              "The chat's sandbox could not start.",
            ),
          ),
        );
      }),
    server: (chatId) =>
      Effect.sync(() => {
        const entry = chats.get(chatId);
        return entry?.state === "running" ? Option.fromNullishOr(entry.server) : Option.none();
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
            yield* remove;
            chats.delete(chatId);
          }),
        );
      }),
  });
});

export const layer = Layer.effect(ChatTable, make);
