/*
 * The runner's chat VMs, in memory. T45 starts a new VM for every execution of a chat and removes
 * it when the execution ends; the runner removes VMs only when T45 asks. T45 saves the VM's /work
 * when the execution finishes and puts it back at the next execution's start.
 */
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
  /** The running VM's server; null while it boots or once it is gone. */
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
    /** Puts a file in the running chat's VM; refuses when the chat doesn't run. */
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
      server: null,
    };
    chats.set(chatId, entry);
    return entry;
  });

  return ChatTable.of({
    start: ({ chatId, chat }) =>
      Effect.gen(function* () {
        const entry = yield* entryFor(chatId);
        // The start finishes even when T45 drops the request, so a remove T45 sends next waits for
        // it and removes the VM it made; T45 removes one that failed to start the same way.
        yield* entry.lock.withPermit(
          Effect.sync(() => {
            entry.server = null;
          }).pipe(
            Effect.andThen(sandboxes.start({ chatId, chat })),
            Effect.map((server) => {
              entry.server = server;
            }),
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
        return Option.fromNullishOr(entry?.server);
      }),
    writeFile: (input) =>
      sandboxes
        .write(input)
        .pipe(
          refuseOnSandboxError(
            "Writing a file into a chat's VM failed",
            "The file could not be added.",
          ),
        ),
    readWorkspace: (chatId) =>
      sandboxes
        .packWorkspace(chatId)
        .pipe(
          refuseOnSandboxError(
            "Packing a chat's workspace failed",
            "The workspace could not be saved.",
          ),
        ),
    writeWorkspace: ({ chatId, content }) =>
      sandboxes
        .unpackWorkspace({ chatId, content })
        .pipe(
          refuseOnSandboxError(
            "Unpacking a chat's workspace failed",
            "The workspace could not be restored.",
          ),
        ),
    remove: (chatId) =>
      Effect.gen(function* () {
        const entry = chats.get(chatId);
        if (entry === undefined) return;
        yield* entry.lock.withPermit(
          Effect.gen(function* () {
            entry.server = null;
            yield* sandboxes.remove(chatId);
            chats.delete(chatId);
          }),
        );
      }),
  });
});

export const layer = Layer.effect(ChatTable, make);
