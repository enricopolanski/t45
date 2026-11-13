import type { AttachmentId } from "@t45/contracts/models/Attachment";
import { type Chat, type ChatId, type Input, titleOf } from "@t45/contracts/models/Chat";
import { InputMetadata } from "@t45/contracts/resources/Chats";
import type { ExecutionRequest, ExecutionUpdate } from "@t45/contracts/resources/Runner";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { SkillRepository } from "../agents/SkillRepository.ts";
import { CapabilityRepository } from "../capabilities/CapabilityRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import { ChatEvents } from "./ChatEvents.ts";
import { inputMessageId, rootSessionId } from "./ChatIds.ts";
import { ChatRepository } from "./ChatRepository.ts";
import * as PromptService from "./PromptService.ts";
import * as ServerConfig from "../config.ts";

const encodeInputMetadata = Schema.encodeSync(InputMetadata);

export type Posted = Pick<Input, "inputId" | "payload">;

const messageOf = (chatId: ChatId, { inputId, payload }: Posted) => ({
  id: inputMessageId(chatId, inputId),
  text: PromptService.format(payload),
  metadata: encodeInputMetadata({ t45: payload }),
});

/** The only one running a chat's executions; a stop asks it to end the current one. */
interface Owner {
  stop: Deferred.Deferred<void>;
  readonly token: string;
}

/**
 * One execution at a time per chat while it is owed one. It starts from the agent's current setup,
 * the disk the last finished execution left, and inputs missing from that disk. Stored messages
 * and sessions are retained when execution stops or fails.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const serverUrl = yield* ServerConfig.serverUrl;
  const toolInstance = yield* ServerConfig.toolInstance;
  const repository = yield* ChatRepository;
  const changes = yield* ChatEvents;
  const runner = yield* RunnerService;
  const agents = yield* AgentRepository;
  const skills = yield* SkillRepository;
  const capabilities = yield* CapabilityRepository;
  const attachments = yield* AttachmentRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const endHandler = yield* Deferred.make<(chatId: ChatId) => Effect.Effect<void>>();
  const owners = new Map<ChatId, Owner>();

  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "questions") =>
    changes.publish({ kind, chatId });

  const filesOf = (ids: ReadonlyArray<AttachmentId>) =>
    Effect.forEach(ids, (id) =>
      fileSystem
        .readFile(attachments.path(id))
        .pipe(Effect.map((content) => [PromptService.attachmentFile(id), content] as const)),
    ).pipe(Effect.map(Object.fromEntries), Effect.orDie);

  const clearQuestions = (chatId: ChatId) =>
    Effect.gen(function* () {
      if (yield* repository.setQuestions(chatId, [])) yield* publish(chatId, "questions");
    });

  const settleMessages = (chatId: ChatId) =>
    Effect.gen(function* () {
      const settled = yield* repository.settleMessages(chatId);
      const sessions = new Map<string, Array<string>>();
      for (const { sessionId, messageId } of settled) {
        const ids = sessions.get(sessionId) ?? [];
        ids.push(messageId);
        sessions.set(sessionId, ids);
      }
      yield* sql.afterCommit(
        Effect.forEach(sessions, ([sessionId, messageIds]) =>
          changes.publish({ kind: "messages", chatId, sessionId, messageIds }),
        ),
      );
    });

  /** Commits what a finished execution wrote; the chat stays owed while an input is pending. */
  const end = (
    chatId: ChatId,
    onEnd: (chatId: ChatId) => Effect.Effect<void>,
    status: "failed" | null,
    disk?: Uint8Array,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* repository.get(chatId))?.status !== "running") return;
          yield* settleMessages(chatId);
          if (disk !== undefined) {
            // SQL rollback cannot undo this replacement; a failed commit can leave the disk ahead of the rows.
            yield* repository.saveDisk(chatId, disk);
            yield* repository.commit(chatId);
            if ((yield* repository.pendingInputs(chatId)).length > 0) return;
          }
          yield* repository.setStatus(chatId, status, yield* nowIso);
          yield* onEnd(chatId);
          yield* sql.afterCommit(publish(chatId, "chat"));
        }),
      )
      .pipe(Effect.orDie);

  const requestOf = (chat: Chat, token: string) =>
    Effect.gen(function* () {
      const agent = (yield* agents.get(chat.agentId))!;
      const origin = yield* repository.origins.get(chat.id);
      const inputs = yield* repository.executionInputs(chat.id);
      const context: Record<string, string> = {
        serverUrl,
        instanceId: toolInstance,
        stepId:
          origin?.kind === "automation" && origin.trigger.type === "step"
            ? origin.trigger.stepId
            : "",
        projectId: origin?.kind === "conversation" ? (origin.projectId ?? "") : "",
      };
      return {
        agent: {
          ...Struct.pick(agent, ["instructions", "model", "permissions", "files"]),
          capabilities: (yield* capabilities.listForAgent(agent.id))
            .filter((capability) => (capability.requiredContext ?? []).every((key) => context[key]))
            .map((capability) =>
              Struct.pick(capability, [
                "files",
                "mcpServers",
                "environment",
                "hosts",
                "secrets",
                "note",
              ]),
            ),
          skills: (yield* skills.listForAgent(agent.id)).map((skill) =>
            Struct.pick(skill, ["name", "description", "content", "files"]),
          ),
        },
        serverUrl,
        context,
        toolToken: Redacted.make(token),
        rootId: rootSessionId(chat.id),
        title: titleOf(chat),
        allowQuestions: origin?.kind === "conversation",
        disk: yield* repository.readDisk(chat.id),
        files: yield* filesOf(
          inputs.flatMap((input) => input.payload.attachments.map((file) => file.id)),
        ),
        messages: inputs.map((input) => messageOf(chat.id, input)),
      } satisfies ExecutionRequest;
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

  /** No automatic retry: chat output may already have caused workflow or external tool effects. */
  const execute = (chat: Chat, token: string, onEnd: (chatId: ChatId) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const chatId = chat.id;
      yield* clearQuestions(chatId);
      const request = yield* requestOf(chat, token);
      const handle = (event: ExecutionUpdate): Effect.Effect<void> => {
        switch (event._tag) {
          case "sessions":
            return Effect.gen(function* () {
              let changed = false;
              for (const info of event.sessions) {
                const parentSessionId = info.id === request.rootId ? null : (info.parentID ?? null);
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
              yield* changes.publish({
                chatId,
                kind: "messages",
                sessionId: event.sessionId,
                messageIds: saved.messageIds,
              });
            });
          case "delta":
            return changes.publish({ chatId, kind: "delta", event });
          case "questions":
            return repository
              .setQuestions(chatId, event.forms)
              .pipe(
                Effect.flatMap((changed) => (changed ? publish(chatId, "questions") : Effect.void)),
              );
          case "heartbeat":
            return Effect.void;
          case "finished":
            return end(chatId, onEnd, event.outcome, event.disk);
        }
      };
      yield* runner.execute(request).pipe(Stream.runForEach(handle));
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("A chat's execution failed; it waits for its next input", {
              chatId: chat.id,
              cause,
            });
            yield* clearQuestions(chat.id);
            yield* end(chat.id, onEnd, "failed");
          }),
      ),
    );

  /** A stop ends the current execution and clears its transient questions. */
  const own = (chatId: ChatId, owner: Owner) =>
    Effect.gen(function* () {
      const onEnd = yield* Deferred.await(endHandler);
      while (true) {
        const chat = yield* owed(chatId);
        if (chat === null) return;
        const stopped = yield* execute(chat, owner.token, onEnd).pipe(
          Effect.as(false),
          Effect.raceFirst(Deferred.await(owner.stop).pipe(Effect.as(true))),
        );
        if (stopped) {
          yield* clearQuestions(chatId);
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
    Effect.gen(function* () {
      const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      if (!owners.has(chatId)) {
        const owner: Owner = { stop: Deferred.makeUnsafe<void>(), token };
        owners.set(chatId, owner);
        return yield* Effect.forkIn(own(chatId, owner), scope).pipe(Effect.asVoid);
      }
      if (posted === undefined) return;
      return yield* filesOf(posted.payload.attachments.map((file) => file.id)).pipe(
        Effect.flatMap((files) =>
          runner.send({ rootId: rootSessionId(chatId), message: messageOf(chatId, posted), files }),
        ),
        Effect.catchTags({
          RpcClientError: (error) =>
            Effect.logWarning("Sending a chat's message failed", { chatId, error }),
        }),
      );
    });

  return {
    deliver,
    settleMessages,
    filesOf,
    onEnd: (handler: (chatId: ChatId) => Effect.Effect<void>) =>
      Deferred.succeed(endHandler, handler),
    chatForToken: (token: string) =>
      [...owners].find(([, owner]) => owner.token === token)?.[0] ?? null,
    /** The owner runs again only for an input posted since. */
    stop: (chatId: ChatId) =>
      Effect.suspend(() => {
        const owner = owners.get(chatId);
        return owner === undefined ? Effect.void : Deferred.succeed(owner.stop, undefined);
      }).pipe(Effect.asVoid),
  };
});
