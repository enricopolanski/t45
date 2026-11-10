import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  canChatWithMembers,
  PROJECT_TOOLS_MCP_NAME,
  type Agent,
} from "@t45/contracts/models/Agent";
import { limitRefusal } from "@t45/contracts/models/Attachment";
import {
  ChatId,
  InputId,
  InputPayload,
  inputRefusal,
  titleFromText,
  Refused,
  titleOf,
  type Chat,
} from "@t45/contracts/models/Chat";
import type { ChatOrigin, Trigger } from "@t45/contracts/models/ChatOrigin";
import type { Role } from "@t45/contracts/models/User";
import { StringId } from "@t45/contracts/models/primitives";
import {
  type ChatEvent,
  ChatList,
  ChatMessage,
  type ChatSession,
  type PendingInput,
  type Question,
  type Chats,
} from "@t45/contracts/resources/Chats";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAccess as makeProjectAccess } from "../workflows/ProjectAssistant.ts";
import { ProjectRepository } from "../workflows/ProjectRepository.ts";
import * as AgentRepository from "../agents/AgentRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import * as ChatEvents from "./ChatEvents.ts";
import * as ChatExecutions from "./ChatExecutions.ts";
import { inputMessageId, rootSessionId } from "./ChatIds.ts";
import * as ChatRepository from "./ChatRepository.ts";
import * as PromptService from "./PromptService.ts";

import { replaceComposerContextReferences } from "@t45/core/composerContextReferences";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";

export interface Member {
  readonly userId: StringId;
  readonly role: Role;
}

type ChatRpc = RpcGroup.Rpcs<typeof Chats>;
type Payload<Tag extends ChatRpc["_tag"]> = Rpc.Payload<Rpc.ExtractTag<ChatRpc, Tag>>;

interface Start {
  readonly agentId: string;
  readonly title: string | null;
  readonly origin: ChatOrigin;
}
interface Post {
  readonly chatId: ChatId;
  readonly inputId: InputId;
  readonly from: string | null;
  readonly input: InputPayload;
  readonly start?: Start;
}
const refuse = (reason: Refused["reason"]) => new Refused({ reason });
const notFound = () => new NotFound();
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(InputPayload));

const PAGE_MESSAGES = 50;
const PAGE_BYTES = 512 * 1024;

const READ_STRING_LIMIT = 8_000;

const cut = (value: unknown, key: string | undefined, cutAny: { cut: boolean }): unknown => {
  if (typeof value === "string") {
    if (key === "data" && value.length > 0) {
      cutAny.cut = true;
      return "";
    }
    if (value.length <= READ_STRING_LIMIT) return value;
    cutAny.cut = true;
    return value.slice(0, READ_STRING_LIMIT);
  }
  if (Array.isArray(value)) return value.map((item) => cut(item, undefined, cutAny));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entry, item]) => [entry, cut(item, entry, cutAny)]),
    );
  }
  return value;
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeWireMessage = Schema.decodeUnknownEffect(SessionMessage.Info);

const readMessage = (
  sessionId: string,
  row: ChatRepository.MessageRow,
  options?: { readonly whole: boolean },
) =>
  Effect.gen(function* () {
    const flag = { cut: false };
    const raw = decodeJson(row.json);
    const message = yield* decodeWireMessage(
      options?.whole === true ? raw : cut(raw, undefined, flag),
    );
    return {
      sessionId: Session.ID.make(sessionId),
      state: row.isLive === 1 ? "live" : "settled",
      isTruncated: flag.cut,
      message,
    } satisfies ChatMessage;
  }).pipe(Effect.orDie);

const encodeChatMessage = Schema.encodeSync(Schema.fromJsonString(ChatMessage));
const hasProjectTools = (agent: Agent) =>
  agent.mcpServers[PROJECT_TOOLS_MCP_NAME] !== undefined &&
  agent.mcpServers[PROJECT_TOOLS_MCP_NAME]?.disabled !== true;

const readBytes = (message: ChatMessage) =>
  new TextEncoder().encode(encodeChatMessage(message)).byteLength;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));
  const repository = yield* ChatRepository.ChatRepository;
  const changes = yield* ChatEvents.ChatEvents;
  const runner = yield* RunnerService;
  const agents = yield* AgentRepository.AgentRepository;
  const projects = yield* ProjectRepository;
  const projectAccess = yield* makeProjectAccess;
  const attachments = yield* AttachmentRepository.AttachmentRepository;
  const origins = repository.origins;
  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "posted" | "deleted") =>
    changes.publish({ kind, chatId });
  const scope = yield* Effect.scope;
  const executions = yield* ChatExecutions.make;
  /** Members see the input, and execution takes it, once the post commits. */
  const announce = (chatId: ChatId, posted: ChatExecutions.Posted) =>
    sql.afterCommit(
      publish(chatId, "posted").pipe(Effect.andThen(executions.deliver(chatId, posted))),
    );
  /** Refuses when the runner didn't answer. */
  const unavailable = (chatId: ChatId) => (error: unknown) =>
    Effect.logWarning("The runner refused a chat's request", { chatId, error }).pipe(
      Effect.andThen(refuse("unavailable")),
    );

  const post = Effect.fnUntraced(function* (post: Post) {
    const chat = yield* repository.get(post.chatId);
    const at = yield* nowIso;
    if (chat === null) {
      const start = post.start;
      if (start === undefined || (yield* repository.exists(post.chatId))) return yield* notFound();
      const agent = yield* agents.get(start.agentId);
      if (
        agent === null ||
        (start.origin.kind === "conversation"
          ? !canChatWithMembers(agent)
          : agent.status !== "active")
      )
        return yield* refuse("agent_unavailable");
      if (start.origin.kind === "conversation") {
        if (start.origin.projectId !== null) {
          yield* projectAccess.load(start.origin.ownerUserId, start.origin.projectId);
          if (!hasProjectTools(agent)) return yield* refuse("agent_unavailable");
        } else if (hasProjectTools(agent)) return yield* refuse("agent_unavailable");
      }
      yield* repository.insert({ id: post.chatId, ...start, at });
      yield* origins.insert(start.origin);
    }
    const payloadJson = encodePayload(post.input);
    if (chat !== null) {
      const sent = yield* repository.input(post.chatId, post.inputId);
      if (sent !== null) {
        if (encodePayload(sent.payload) !== payloadJson) {
          return yield* refuse("input_conflict");
        }
        return;
      }
    }
    const refusal = inputRefusal(post.input, PromptService.format(post.input).length);
    if (refusal !== null) return yield* refuse(refusal);

    yield* attachments.bindToChat(post.chatId, post.input.attachments, post.from);
    yield* repository.addInput(post.chatId, { inputId: post.inputId, payload: post.input, at });
    yield* repository.markRunning(post.chatId, at);
    if ((chat?.title ?? post.start?.title ?? null) === null) {
      const plainText = replaceComposerContextReferences(post.input.text, () => "");
      yield* repository.setTitleIfUntitled(
        post.chatId,
        titleFromText(plainText, post.input.attachments),
      );
    }
    yield* announce(post.chatId, { inputId: post.inputId, payload: post.input });
  }, transaction);

  /** Recorded as interrupted at once, so a server start doesn't run it again. */
  const requestStop = Effect.fnUntraced(function* (chatId: ChatId) {
    if (!(yield* repository.setStatus(chatId, "interrupted", yield* nowIso))) return false;
    yield* executions.settleMessages(chatId);
    yield* sql.afterCommit(publish(chatId, "chat").pipe(Effect.andThen(executions.stop(chatId))));
    return true;
  }, transaction);

  /** Stops what runs for a deleted chat, then removes its files, disk and copy. */
  const cleanup = (chatId: ChatId) =>
    Effect.gen(function* () {
      yield* executions.stop(chatId);
      yield* attachments.release(chatId);
      yield* repository.deleteDisk(chatId);
      yield* repository.finishDelete(chatId);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Cleaning up a deleted chat failed", {
              chatId,
              cause,
            }),
      ),
    );

  const liveChat = (chatId: ChatId) =>
    repository.get(chatId).pipe(Effect.filterOrFail((chat) => chat !== null, notFound));
  const access = (member: Member, chatId: ChatId) =>
    Effect.gen(function* () {
      const origin = yield* origins.get(chatId);
      if (origin?.kind !== "conversation" || origin.ownerUserId !== member.userId) return null;
      return yield* repository.get(chatId);
    });
  const memberChat = (member: Member, chatId: ChatId) =>
    access(member, chatId).pipe(Effect.filterOrFail((chat) => chat !== null, notFound));
  const summaryOf = (chat: Chat, agentName: string | null) =>
    Effect.gen(function* () {
      const origin = yield* origins.get(chat.id);
      const projectId = origin?.kind === "conversation" ? origin.projectId : null;
      return {
        ...chat,
        agentName,
        projectId,
        projectName: projectId === null ? null : ((yield* projects.get(projectId))?.name ?? null),
      };
    });
  const openChatOf = (chat: Chat) =>
    agents.get(chat.agentId).pipe(Effect.flatMap((agent) => summaryOf(chat, agent?.name ?? null)));

  const sessionsOf = (chat: Chat) =>
    Effect.gen(function* () {
      const root = rootSessionId(chat.id);
      const rows = yield* repository.sessions(chat.id);
      const sessions: Array<ChatSession> = [];
      if (!rows.some((row) => row.sessionId === root)) {
        sessions.push({ id: root, title: titleOf(chat) });
      }
      for (const row of rows) {
        sessions.push({
          id: Session.ID.make(row.sessionId),
          parentID: row.parentSessionId === null ? undefined : Session.ID.make(row.parentSessionId),
          title: row.sessionId === root ? titleOf(chat) : row.info.title,
        });
      }
      return sessions;
    });

  const sessionOf = (chat: Chat, sessionId: string) =>
    Effect.gen(function* () {
      if (sessionId === rootSessionId(chat.id)) return sessionId;
      const rows = yield* repository.sessions(chat.id);
      if (!rows.some((row) => row.sessionId === sessionId)) {
        return yield* notFound();
      }
      return sessionId;
    });

  const inputsOf = (chatId: ChatId) =>
    repository.pendingInputs(chatId).pipe(
      Effect.map((rows) =>
        rows.map((row): PendingInput => ({
          inputId: row.inputId,
          text: row.payload.text,
          attachments: row.payload.attachments,
          createdAt: row.createdAt,
        })),
      ),
    );

  const questionsOf = (chatId: ChatId) =>
    repository
      .questions(chatId)
      .pipe(
        Effect.map((rows) => rows.map(({ sessionId, form }): Question => ({ sessionId, form }))),
      );

  const pageOf = (chatId: ChatId, sessionId: string, beforeOrdinal: number | null) =>
    Effect.gen(function* () {
      const page = yield* repository.page(chatId, sessionId, beforeOrdinal, PAGE_MESSAGES);
      const messages: Array<ChatMessage> = [];
      let bytes = 0;
      for (const row of page.rows) {
        const message = yield* readMessage(sessionId, row);
        const size = readBytes(message);
        if (messages.length > 0 && bytes + size > PAGE_BYTES) break;
        messages.push(message);
        bytes += size;
      }
      return {
        messages: messages.toReversed(),
        hasEarlier: page.earlier || messages.length < page.rows.length,
      };
    });

  for (const chatId of yield* repository.owed) yield* executions.deliver(chatId);

  const remove = Effect.fnUntraced(function* (chatId: ChatId) {
    yield* repository.markDeleted(chatId, yield* nowIso);
    yield* sql.afterCommit(
      publish(chatId, "deleted").pipe(Effect.andThen(cleanup(chatId).pipe(Effect.forkIn(scope)))),
    );
  }, transaction);

  return {
    startAutomation: Effect.fnUntraced(function* (
      trigger: Trigger,
      agentId: string,
      { title, input }: { readonly title: string; readonly input: InputPayload },
    ) {
      const chatId = ChatId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      yield* post({
        chatId,
        inputId: InputId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
        from: null,
        input,
        start: { agentId, title, origin: { kind: "automation", chatId, trigger } },
      });
      return chatId;
    }),
    requestStop,
    onEnd: executions.onEnd,
    authenticateAgent: Effect.fnUntraced(function* (token: string) {
      const chatId = executions.chatForToken(token);
      if (chatId === null) return yield* notFound();
      const chat = yield* repository.get(chatId);
      const origin = yield* repository.origins.get(chatId);
      if (chat?.status !== "running" || origin === null) return yield* notFound();
      return { chatId, agentId: chat.agentId, origin };
    }),
    listTargets: (member: Member) =>
      Effect.gen(function* () {
        const available = (yield* agents.list).filter(canChatWithMembers);
        const plain = available
          .filter((agent) => !hasProjectTools(agent))
          .map((agent) => ({
            agentId: agent.id,
            name: agent.name,
            projectId: null,
          }));
        const assistants = available.filter(hasProjectTools);
        if (assistants.length === 0) return plain;
        const actor = { id: member.userId, isOrgAdmin: member.role === "admin" };
        const bound = (yield* projectAccess.list(actor)).flatMap((project) =>
          assistants.map((agent) => ({
            agentId: agent.id,
            name: assistants.length === 1 ? project.name : `${project.name} · ${agent.name}`,
            projectId: project.id,
          })),
        );
        return [...plain, ...bound];
      }),
    access,
    subscribe: (member: Member) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const listed = yield* changes.subscribe(
            (change) =>
              change.kind === "chat" || change.kind === "posted" || change.kind === "deleted",
          );
          const load = repository.list(member).pipe(Effect.map((chats) => ({ chats })));
          return Stream.concat(
            Stream.fromEffect(load),
            listed.pipe(
              Stream.groupedWithin(1_000, "1 second"),
              Stream.mapEffect(() => load),
            ),
          ).pipe(Stream.changesWith(Schema.toEquivalence(ChatList)));
        }),
      ),

    open: (input: Payload<"chats.watch">, member: Member) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const requested = input.sessionId ?? rootSessionId(input.chatId);
          const changed = yield* changes.subscribe(
            (change) =>
              change.chatId === input.chatId &&
              (change.kind === "messages"
                ? change.sessionId === requested
                : change.kind !== "delta" || change.event.sessionId === requested),
          );
          const chat = yield* memberChat(member, input.chatId);
          const sessionId = yield* sessionOf(chat, requested);
          const snapshotOf = Effect.gen(function* () {
            const now = yield* memberChat(member, chat.id);
            const first = yield* pageOf(chat.id, sessionId, null);
            return {
              _tag: "snapshot",
              chat: yield* openChatOf(now),
              sessions: yield* sessionsOf(now),
              messages: first.messages,
              hasEarlier: first.hasEarlier,
              inputs: yield* inputsOf(chat.id),
              questions: yield* questionsOf(chat.id),
            } satisfies ChatEvent;
          });
          const eventsOf = (
            change: ChatEvents.ChatChange | ChatEvents.Missed,
          ): Effect.Effect<ReadonlyArray<ChatEvent>, Refused | NotFound> => {
            switch (change.kind) {
              case "missed":
                return snapshotOf.pipe(Effect.map((snapshot) => [snapshot]));
              case "deleted":
                return Effect.fail(notFound());
              case "chat":
                return liveChat(chat.id).pipe(
                  Effect.flatMap((chat) => openChatOf(chat)),
                  Effect.map((now) => [{ _tag: "chat", chat: now }]),
                );
              case "sessions":
                return liveChat(chat.id).pipe(
                  Effect.flatMap(sessionsOf),
                  Effect.map((sessions) => [{ _tag: "sessions", sessions }]),
                );
              case "messages":
                return repository.messages(chat.id, sessionId, change.messageIds).pipe(
                  Effect.flatMap((rows) =>
                    Effect.forEach(rows, (row) => readMessage(sessionId, row)),
                  ),
                  Effect.map((messages) =>
                    messages.length === 0 ? [] : [{ _tag: "messages", messages }],
                  ),
                );
              case "delta":
                return Effect.succeed([change.event]);
              case "inputs":
                return inputsOf(chat.id).pipe(Effect.map((inputs) => [{ _tag: "inputs", inputs }]));
              case "posted":
                return Effect.all([
                  inputsOf(chat.id),
                  liveChat(chat.id).pipe(Effect.flatMap((chat) => openChatOf(chat))),
                ]).pipe(
                  Effect.map(([inputs, now]) => [
                    { _tag: "inputs", inputs },
                    { _tag: "chat", chat: now },
                  ]),
                );
              case "questions":
                return questionsOf(chat.id).pipe(
                  Effect.map((questions) => [{ _tag: "questions", questions }]),
                );
            }
          };
          return Stream.concat(
            Stream.fromEffect(snapshotOf),
            changed.pipe(Stream.mapEffect(eventsOf), Stream.flattenIterable),
          );
        }),
      ),

    history: (input: Payload<"chats.getHistory">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        const sessionId = yield* sessionOf(chat, input.sessionId);
        const before = yield* repository.message(chat.id, sessionId, input.before);
        if (before === null) return yield* notFound();
        return yield* pageOf(chat.id, sessionId, before.ordinal);
      }),

    message: (input: Payload<"chats.getMessage">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        const sessionId = yield* sessionOf(chat, input.sessionId);
        const row = yield* repository.message(chat.id, sessionId, input.messageId);
        if (row === null) return yield* notFound();
        return yield* readMessage(sessionId, row, { whole: true });
      }),

    send: Effect.fnUntraced(function* (input: Payload<"chats.send">, member: Member) {
      const origin = yield* origins.get(input.chatId);
      if (origin !== null) {
        const existing = yield* memberChat(member, input.chatId);
        if (origin.kind === "conversation" && origin.projectId !== null)
          yield* projectAccess.load(member.userId, origin.projectId);
        if (
          (input.agentId !== undefined && existing.agentId !== input.agentId) ||
          (input.projectId !== undefined &&
            (origin.kind !== "conversation" || origin.projectId !== input.projectId))
        )
          return yield* refuse("id_taken");
      }
      const payload = {
        text: input.text,
        attachments: input.attachments,
      };
      yield* post({
        chatId: input.chatId,
        inputId: input.inputId,
        from: member.userId,
        input: payload,
        ...(origin === null && input.agentId !== undefined
          ? {
              start: {
                agentId: input.agentId,
                title: null,
                origin: {
                  kind: "conversation" as const,
                  chatId: input.chatId,
                  ownerUserId: member.userId,
                  projectId: input.projectId ?? null,
                },
              },
            }
          : {}),
      });
    }, transaction),

    cancel: (input: Payload<"chats.cancel">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        if ((yield* repository.input(chat.id, input.inputId)) === null) return yield* notFound();
        const pending = yield* repository.pendingInputs(chat.id);
        if (!pending.some((each) => each.inputId === input.inputId)) {
          return yield* refuse("already_taken");
        }
        yield* runner
          .cancel({
            rootId: rootSessionId(chat.id),
            messageId: inputMessageId(chat.id, input.inputId),
          })
          .pipe(Effect.catchTags({ RpcClientError: unavailable(chat.id) }));
        yield* repository.deleteInput(chat.id, input.inputId);
        yield* publish(chat.id, "inputs");
      }),

    answer: (input: Payload<"chats.answer">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        const origin = yield* origins.get(chat.id);
        if (origin?.kind === "conversation" && origin.projectId !== null)
          yield* projectAccess.load(member.userId, origin.projectId);
        const asked = (yield* repository.questions(chat.id)).find(
          (question) => question.sessionId === input.sessionId && question.form.id === input.formId,
        );
        if (asked === undefined) return yield* refuse("question_gone");
        const files = Object.entries(input.attachments).filter(([, list]) => list.length > 0);
        for (const [key] of files) {
          const field = asked.form.fields.find((each) => each.key === key);
          if (
            field === undefined ||
            field.type !== "string" ||
            (field.options !== undefined && field.options.length > 0 && field.custom !== true)
          ) {
            return yield* refuse("answer_files_need_text");
          }
        }
        const sent = files.flatMap(([, list]) => list);
        if (sent.length > 0) {
          const refusal = limitRefusal(sent);
          if (refusal !== null) return yield* refuse(refusal);
          yield* transaction(attachments.bindToChat(chat.id, sent, member.userId));
        }
        const answer = PromptService.formatAnswers({
          answers: input.answers,
          attachmentsByField: Object.fromEntries(files),
        });
        yield* runner
          .answer({
            rootId: rootSessionId(chat.id),
            sessionId: input.sessionId,
            formId: input.formId,
            answer,
            files: yield* executions.filesOf(sent.map((file) => file.id)),
          })
          .pipe(
            Effect.catchTags({
              QuestionGone: () => refuse("question_gone"),
              AnswerInvalid: () => refuse("answer_invalid"),
              RpcClientError: unavailable(chat.id),
            }),
          );
      }),

    dismiss: (input: Payload<"chats.dismiss">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        yield* runner
          .dismiss({
            rootId: rootSessionId(chat.id),
            sessionId: input.sessionId,
            formId: input.formId,
          })
          .pipe(
            Effect.catchTags({
              QuestionGone: () => refuse("question_gone"),
              RpcClientError: unavailable(chat.id),
            }),
          );
      }),

    stop: (input: Payload<"chats.stop">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        yield* requestStop(chat.id);
      }),

    rename: (input: Payload<"chats.rename">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* memberChat(member, input.chatId);
        yield* repository.rename(chat.id, input.title);
        yield* publish(chat.id, "chat");
        yield* publish(chat.id, "sessions");
      }),

    delete: Effect.fnUntraced(function* (input: Payload<"chats.delete">, member: Member) {
      const chat = yield* memberChat(member, input.chatId);
      yield* remove(chat.id);
    }, transaction),
  };
});

export class ChatService extends Context.Service<ChatService, Effect.Success<typeof make>>()(
  "t45/chats/ChatService",
) {
  static get layer() {
    return layer;
  }
}
const layer = Layer.effect(ChatService, make).pipe(Layer.provideMerge(ChatEvents.layer));
