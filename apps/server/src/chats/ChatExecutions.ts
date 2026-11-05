import type { SessionMessage } from "@opencode/schema/session-message";
import type { AttachmentId } from "@t45/contracts/models/Attachment";
import { type Chat, type ChatId, type Input, titleOf } from "@t45/contracts/models/Chat";
import { InputMetadata } from "@t45/contracts/resources/Chats";
import type { Execution, ExecutionEvent } from "@t45/contracts/resources/Runner";
import { hasT45Tools } from "@t45/core/agentTools";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { SkillRepository } from "../agents/SkillRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import { ChatEvents } from "./ChatEvents.ts";
import { inputMessageId, rootSessionId } from "./ChatIds.ts";
import { ChatRepository } from "./ChatRepository.ts";
import * as PromptService from "./PromptService.ts";

/** Called on the execution's fiber, before it goes on. */
export type Receive = (
  result: { readonly chatId: ChatId } & (
    | {
        readonly type: "messages";
        readonly messages: ReadonlyArray<SessionMessage.Info>;
        /** The files the agent's tools left for T45, by path. */
        readonly generated: ReadonlyMap<string, Uint8Array>;
      }
    | { readonly type: "ended"; readonly status: "failed" | null }
  ),
) => Effect.Effect<void>;

const RETRY = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

const encodeInputMetadata = Schema.encodeSync(InputMetadata);

export type Posted = Pick<Input, "inputId" | "payload">;

const inputOf = (chatId: ChatId, { inputId, payload }: Posted) => ({
  id: inputMessageId(chatId, inputId),
  text: PromptService.format(payload),
  metadata: encodeInputMetadata({ t45: payload }),
});

/** The only one running a chat's executions; a stop asks it to end the current one. */
interface Owner {
  stop: Deferred.Deferred<void>;
}

/**
 * One execution at a time per chat while it is owed one. It starts from the agent's current setup,
 * the disk the last finished execution left, and the inputs the agent hasn't taken; what an
 * execution that doesn't finish wrote is discarded.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ChatRepository;
  const changes = yield* ChatEvents;
  const runner = yield* RunnerService;
  const agents = yield* AgentRepository;
  const skills = yield* SkillRepository;
  const attachments = yield* AttachmentRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const runtime = path.resolve(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts") ? "../../dist/runtime" : "runtime",
  );
  const toolFiles = yield* fileSystem.readDirectory(runtime).pipe(
    Effect.flatMap((files) =>
      Effect.forEach(
        files.filter((file) => file.endsWith(".mjs")),
        (file) =>
          fileSystem
            .readFileString(path.join(runtime, file))
            .pipe(Effect.map((source) => [`runtime/${file}`, source] as const)),
      ),
    ),
    Effect.map((files) => Object.fromEntries(files)),
    Effect.orDie,
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const receiver = yield* Deferred.make<Receive>();
  const owners = new Map<ChatId, Owner>();

  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "questions") =>
    changes.publish({ kind, chatId });

  const filesOf = (ids: ReadonlyArray<AttachmentId>) =>
    Effect.forEach(ids, (id) =>
      fileSystem
        .readFile(attachments.path(id))
        .pipe(Effect.map((content) => [PromptService.attachmentFile(id), content] as const)),
    ).pipe(Effect.map(Object.fromEntries), Effect.orDie);

  const discard = (chatId: ChatId) =>
    Effect.gen(function* () {
      if (yield* repository.discardUncommitted(chatId)) {
        yield* changes.publish({ chatId, kind: "replaced" });
      }
    });

  /** Commits what a finished execution wrote; the chat stays owed while an input is pending. */
  const end = (chatId: ChatId, receive: Receive, status: "failed" | null, disk?: Uint8Array) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* repository.get(chatId))?.status !== "running") return;
          if (disk !== undefined) {
            yield* repository.saveDisk(chatId, disk);
            yield* repository.commit(chatId);
            if ((yield* repository.pendingInputs(chatId)).length > 0) return;
          }
          yield* repository.setStatus(chatId, status, yield* nowIso);
          yield* receive({ chatId, type: "ended", status });
          yield* sql.afterCommit(publish(chatId, "chat"));
        }),
      )
      .pipe(Effect.orDie);

  const executionOf = (chat: Chat) =>
    Effect.gen(function* () {
      const agent = (yield* agents.get(chat.agentId))!;
      const origin = yield* repository.origins.get(chat.id);
      const inputs = yield* repository.pendingInputs(chat.id);
      return {
        agent: {
          ...Struct.pick(agent, ["instructions", "model", "mcpServers", "permissions"]),
          files: { ...agent.files, ...(hasT45Tools(agent.mcpServers) ? toolFiles : {}) },
          skills: (yield* skills.listForAgent(agent.id)).map((skill) =>
            Struct.pick(skill, ["name", "description", "content", "files"]),
          ),
        },
        root: rootSessionId(chat.id),
        title: titleOf(chat),
        questions: origin?.kind === "conversation",
        disk: yield* repository.readDisk(chat.id),
        files: yield* filesOf(
          inputs.flatMap((input) => input.payload.attachments.map((file) => file.id)),
        ),
        inputs: inputs.map((input) => inputOf(chat.id, input)),
      } satisfies Execution;
    });

  /** Atomic with posts: one that commits after this finds no owner and starts one. */
  const owed = (chatId: ChatId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const chat = yield* repository.get(chatId);
          if (chat?.status === "running") return chat;
          owners.delete(chatId);
          return null;
        }),
      )
      .pipe(Effect.orDie);

  /** A runner out of reach is waited out; any other failure ends the chat `failed`. */
  const execute = (chat: Chat, receive: Receive) =>
    Effect.gen(function* () {
      const chatId = chat.id;
      yield* discard(chatId);
      const execution = yield* executionOf(chat);
      const generated = new Map<string, Uint8Array>();
      const handle = (event: ExecutionEvent): Effect.Effect<void> => {
        switch (event._tag) {
          case "sessions":
            return Effect.gen(function* () {
              let changed = false;
              for (const info of event.sessions) {
                const parentSessionId = info.id === execution.root ? null : (info.parentID ?? null);
                changed =
                  (yield* repository.putSession(chatId, {
                    sessionId: info.id,
                    parentSessionId,
                    info,
                  })) || changed;
              }
              if (changed) yield* publish(chatId, "sessions");
            });
          case "messages":
            return Effect.gen(function* () {
              const saved = yield* repository.saveMessages(chatId, event.sessionId, event.messages);
              if (saved.inputsTaken) yield* publish(chatId, "inputs");
              if (saved.messageIds.length === 0) return;
              const written = new Set(saved.messageIds);
              yield* receive({
                chatId,
                type: "messages",
                messages: event.messages.filter((message) => written.has(message.id)),
                generated,
              });
              yield* changes.publish({
                chatId,
                kind: "messages",
                sessionId: event.sessionId,
                messageIds: saved.messageIds,
              });
            });
          case "delta":
            return changes.publish({
              chatId,
              kind: "delta",
              sessionId: event.sessionId,
              messageId: event.messageId,
              ordinal: event.ordinal,
              part: event.kind,
              delta: event.delta,
            });
          case "questions":
            return repository
              .setQuestions(chatId, event.forms)
              .pipe(
                Effect.flatMap((changed) => (changed ? publish(chatId, "questions") : Effect.void)),
              );
          case "file":
            return Effect.sync(() => void generated.set(event.path, event.content));
          case "heartbeat":
            return Effect.void;
          case "restarted":
            return Effect.sync(() => generated.clear()).pipe(Effect.andThen(discard(chatId)));
          case "finished":
            return end(chatId, receive, event.outcome, event.disk);
        }
      };
      yield* runner.run({ id: chatId, execution }).pipe(Stream.runForEach(handle));
    }).pipe(
      Effect.retry({
        schedule: RETRY,
        while: (error) =>
          Predicate.isTagged(error, "RpcClientError")
            ? Effect.logWarning("The runner is out of reach; the chat's execution runs again", {
                chatId: chat.id,
                error,
              }).pipe(Effect.as(true))
            : Effect.succeed(false),
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("A chat's execution failed; it waits for its next input", {
              chatId: chat.id,
              cause,
            });
            yield* discard(chat.id);
            yield* end(chat.id, receive, "failed");
          }),
      ),
    );

  /** A stop ends the current execution and discards what it wrote. */
  const own = (chatId: ChatId, owner: Owner) =>
    Effect.gen(function* () {
      const receive = yield* Deferred.await(receiver);
      while (true) {
        const chat = yield* owed(chatId);
        if (chat === null) return;
        const stopped = yield* execute(chat, receive).pipe(
          Effect.as(false),
          Effect.raceFirst(Deferred.await(owner.stop).pipe(Effect.as(true))),
        );
        if (stopped) {
          yield* discard(chatId);
          owner.stop = yield* Deferred.make<void>();
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (owners.get(chatId) === owner) owners.delete(chatId);
        }),
      ),
    );

  /** Starts the chat's owner unless it has one, which gets the input just posted. */
  const deliver = (chatId: ChatId, posted?: Posted): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!owners.has(chatId)) {
        const owner: Owner = { stop: Deferred.makeUnsafe<void>() };
        owners.set(chatId, owner);
        return Effect.forkIn(own(chatId, owner), scope).pipe(Effect.asVoid);
      }
      if (posted === undefined) return Effect.void;
      return filesOf(posted.payload.attachments.map((file) => file.id)).pipe(
        Effect.flatMap((files) =>
          runner.send({ id: chatId, input: inputOf(chatId, posted), files }),
        ),
        Effect.catchTags({
          RpcClientError: (error) =>
            Effect.logWarning("Sending a chat's input failed", { chatId, error }),
        }),
      );
    });

  return {
    deliver,
    filesOf,
    consume: (receive: Receive) => Deferred.succeed(receiver, receive),
    /** The owner runs again only for an input posted since. */
    stop: (chatId: ChatId) =>
      Effect.suspend(() => {
        const owner = owners.get(chatId);
        return owner === undefined ? Effect.void : Deferred.succeed(owner.stop, undefined);
      }).pipe(Effect.asVoid),
  };
});
