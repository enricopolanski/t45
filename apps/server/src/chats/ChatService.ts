import { Session, SessionMessage } from "@opencode/client/effect";
import { canChatWithMembers, WORKFLOW_ASSISTANT_ID } from "@t45/contracts/models/Agent";
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
import type { ChatOrigin } from "@t45/contracts/models/Task";
import type { Role } from "@t45/contracts/models/User";
import { StringId } from "@t45/contracts/models/primitives";
import {
  type ChatErrors,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentRepository from "../agents/AgentRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import * as PromptService from "../runner/PromptService.ts";
import { type ChatVm, RunnerService } from "../runner/RunnerService.ts";
import * as ChatEvents from "./ChatEvents.ts";
import { rootSessionId } from "./ChatIds.ts";
import * as WorkflowToolReceipts from "./WorkflowToolReceipts.ts";
import * as ChatRepository from "./ChatRepository.ts";
import type { WorkflowChatHooks } from "./WorkflowChatHooks.ts";

import { replaceComposerContextReferences } from "@t45/core/composerContextReferences";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as FiberMap from "effect/FiberMap";
import * as Schedule from "effect/Schedule";
import { TaskService, make as makeTasks, type StepHooks } from "../tasks/TaskService.ts";

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
export interface Post {
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
const isRefused = Schema.is(Refused);

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
      state: row.state,
      isTruncated: flag.cut,
      message,
    } satisfies ChatMessage;
  }).pipe(Effect.orDie);

const encodeChatMessage = Schema.encodeSync(Schema.fromJsonString(ChatMessage));

const readBytes = (message: ChatMessage) =>
  new TextEncoder().encode(encodeChatMessage(message)).byteLength;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));
  const repository = yield* ChatRepository.ChatRepository;
  const changes = yield* ChatEvents.ChatEvents;
  const runner = yield* RunnerService;
  const agents = yield* AgentRepository.AgentRepository;
  const attachments = yield* AttachmentRepository.AttachmentRepository;
  const origins = repository.origins;
  const workflowHooks = yield* Deferred.make<WorkflowChatHooks | null>();
  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "posted" | "deleted") =>
    changes.publish({ kind, chatId });
  const cleanups = yield* FiberMap.make<string>();
  const scope = yield* Effect.scope;
  const announce = (chatId: ChatId) => sql.afterCommit(publish(chatId, "posted"));

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
        if (sent.state === "waiting") yield* announce(post.chatId);
        return;
      }
    }
    const refusal = inputRefusal(post.input, PromptService.format(post.input).length);
    if (refusal !== null) return yield* refuse(refusal);

    yield* attachments.bindToChat(post.chatId, post.input.attachments, post.from);
    yield* repository.addInput(post.chatId, { inputId: post.inputId, payload: post.input, at });
    yield* repository.markRunning(post.chatId);
    if ((chat?.title ?? post.start?.title ?? null) === null) {
      const plainText = replaceComposerContextReferences(post.input.text, () => "");
      yield* repository.setTitleIfUntitled(
        post.chatId,
        titleFromText(plainText, post.input.attachments),
      );
    }
    yield* announce(post.chatId);
  }, transaction);

  const requestStop = Effect.fnUntraced(function* (chatId: ChatId) {
    const chat = yield* repository.requestStop(chatId);
    if (chat !== null) yield* announce(chat.id);
  }, transaction);

  const onVm = <A, E>(
    chatId: ChatId,
    job: (vm: ChatVm) => Effect.Effect<A, E>,
    options?: { readonly boot?: boolean },
  ) =>
    runner
      .run(
        chatId,
        (vm) =>
          job(vm).pipe(
            Effect.catchCause((cause): Effect.Effect<A, Refused> => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
              const error = Cause.findErrorOption(cause);
              if (Option.isSome(error) && isRefused(error.value)) return error.value;
              return Effect.logWarning("A chat's VM refused a request", { chatId, cause }).pipe(
                Effect.andThen(refuse("unavailable")),
              );
            }),
          ),
        options,
      )
      .pipe(Effect.catchTags({ JobTimeoutError: () => refuse("unavailable") }));

  const cleanup = (chatId: ChatId) =>
    Effect.gen(function* () {
      yield* runner.removeChat(chatId);
      yield* attachments.release(chatId);
      yield* repository.deleteWorkspace(chatId);
      yield* repository.finishDelete(chatId);
    });

  const cleanUntilDone = (chatId: ChatId) =>
    cleanup(chatId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Cleaning up a deleted chat failed; trying again", {
              chatId,
              cause,
            }).pipe(
              Effect.andThen(
                FiberMap.run(
                  cleanups,
                  chatId,
                  cleanup(chatId).pipe(
                    Effect.tapCause((retry) =>
                      Effect.logWarning("Cleaning up a deleted chat failed", {
                        chatId,
                        cause: retry,
                      }),
                    ),
                    Effect.catchCause((retry) =>
                      Cause.hasInterruptsOnly(retry) ? Effect.interrupt : Effect.fail(retry),
                    ),
                    Effect.retry(Schedule.spaced("30 seconds")),
                    Effect.orDie,
                  ),
                  { onlyIfMissing: true },
                ),
              ),
              Effect.asVoid,
            ),
      ),
    );

  const steps = yield* Deferred.make<StepHooks>();
  const tasks = yield* makeTasks({ post, requestStop }, Deferred.await(steps));
  const workflowName = (userId: string, workflowId: string) =>
    Effect.flatMap(Deferred.await(workflowHooks), (hooks) =>
      hooks === null ? notFound() : hooks.name(userId, workflowId),
    );
  const workflowInstructions = (chatId: ChatId) =>
    Effect.gen(function* () {
      const workflowId = yield* repository.workflowId(chatId);
      const origin = yield* origins.get(chatId);
      const hooks = yield* Deferred.await(workflowHooks);
      if (workflowId === null || origin?.kind !== "conversation" || hooks === null) return "";
      return yield* hooks.context(origin.ownerUserId, workflowId).pipe(
        Effect.catchTags({
          NotFound: () =>
            Effect.succeed(
              "This workflow is no longer available to this person. Explain that access is unavailable.",
            ),
        }),
      );
    });
  const workflowCalls = yield* WorkflowToolReceipts.make(Deferred.await(workflowHooks));
  const liveChat = (chatId: ChatId) =>
    repository.get(chatId).pipe(Effect.filterOrFail((chat) => chat !== null, notFound));
  const permission = (member: Member, chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* repository.get(chatId);
      if (chat === null) return null;
      const origin = yield* origins.get(chatId);
      const workflowId = yield* repository.workflowId(chatId);
      if (
        workflowId !== null &&
        !(yield* workflowName(member.userId, workflowId).pipe(Effect.isSuccess))
      )
        return null;
      const mode =
        origin?.kind === "conversation" && origin.ownerUserId === member.userId ? "write" : null;
      return mode === null ? null : { chat, mode };
    });
  const access = (member: Member, chatId: ChatId) =>
    permission(member, chatId).pipe(Effect.map((result) => result?.chat ?? null));
  const memberChat = (member: Member, chatId: ChatId) =>
    access(member, chatId).pipe(Effect.filterOrFail((chat) => chat !== null, notFound));
  const commandChat = (member: Member, chatId: ChatId) =>
    permission(member, chatId).pipe(
      Effect.flatMap((result) =>
        result?.mode === "write" ? Effect.succeed(result.chat) : notFound(),
      ),
    );
  const summaryOf = (chat: Chat, agentName: string | null) =>
    Effect.gen(function* () {
      const workflowId = yield* repository.workflowId(chat.id);
      const origin = yield* origins.get(chat.id);
      if (workflowId === null || origin?.kind !== "conversation") return { ...chat, agentName };
      return {
        ...chat,
        workflowId,
        agentName: yield* workflowName(origin.ownerUserId, workflowId).pipe(
          Effect.orElseSucceed(() => null),
        ),
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
    repository.openInputs(chatId).pipe(
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

  return {
    tasks,
    access,
    targets: (member: Member) =>
      Effect.gen(function* () {
        const configured = yield* agents.list;
        const available = configured.filter(canChatWithMembers);
        const regular = available
          .filter((agent) => agent.id !== WORKFLOW_ASSISTANT_ID)
          .map((agent) => ({ agentId: agent.id, name: agent.name }));
        const hooks = yield* Deferred.await(workflowHooks);
        return [
          ...regular,
          ...(hooks !== null && available.some((agent) => agent.id === WORKFLOW_ASSISTANT_ID)
            ? yield* hooks.targets(member.userId)
            : []),
        ];
      }),
    subscribe: (member: Member) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const listed = yield* changes.subscribe(
            (change) =>
              change.kind === "chat" || change.kind === "posted" || change.kind === "deleted",
          );
          const load = Effect.gen(function* () {
            const names = new Map((yield* agents.list).map((agent) => [agent.id, agent.name]));
            const chats = yield* Effect.filter(yield* repository.list(member), (chat) =>
              access(member, chat.id).pipe(Effect.map((chat) => chat !== null)),
            );
            return {
              chats: yield* Effect.forEach(chats, (chat) =>
                summaryOf(chat, names.get(chat.agentId) ?? null),
              ),
            };
          });
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
              ((change.kind !== "messages" && change.kind !== "delta") ||
                change.sessionId === requested),
          );
          const chat = yield* memberChat(member, input.chatId);
          const sessionId = yield* sessionOf(chat, requested);
          const snapshotOf = Effect.gen(function* () {
            const now = yield* liveChat(chat.id);
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
          ): Effect.Effect<ReadonlyArray<ChatEvent>, ChatErrors> => {
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
                return Effect.succeed([
                  {
                    _tag: "delta",
                    sessionId: Session.ID.make(change.sessionId),
                    messageId: SessionMessage.ID.make(change.messageId),
                    ordinal: change.ordinal,
                    kind: change.part,
                    delta: change.delta,
                  },
                ]);
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
            changed.pipe(
              Stream.mapEffect((event) =>
                memberChat(member, chat.id).pipe(Effect.andThen(eventsOf(event))),
              ),
              Stream.flattenIterable,
            ),
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
      const workflowId =
        origin === null ? (input.workflowId ?? null) : yield* repository.workflowId(input.chatId);
      if (origin !== null) {
        const existing = yield* commandChat(member, input.chatId);
        if (input.agentId !== undefined && existing.agentId !== input.agentId)
          return yield* refuse("id_taken");
        if (input.workflowId !== undefined && workflowId !== input.workflowId)
          return yield* refuse("id_taken");
      }
      if (workflowId !== null) {
        yield* workflowName(member.userId, workflowId);
        if (origin === null && input.agentId !== WORKFLOW_ASSISTANT_ID)
          return yield* refuse("agent_unavailable");
      } else if (origin === null && input.agentId === WORKFLOW_ASSISTANT_ID)
        return yield* refuse("agent_unavailable");
      const payload = {
        text: input.text,
        attachments: input.attachments,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(workflowId === null ? {} : { workflowId }),
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
                },
              },
            }
          : {}),
      });
    }, transaction),

    cancel: (input: Payload<"chats.cancel">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
        const sent = yield* repository.input(chat.id, input.inputId);
        if (sent === null) return yield* notFound();
        if (sent.state === "cancelled") return;
        if (sent.state === "materialized") return yield* refuse("already_taken");
        const cancelled = yield* runner.whileNotDelivering(
          chat.id,
          repository.moveInput(chat.id, sent.inputId, ["waiting"], "cancelled"),
        );
        if (!cancelled) {
          const withdrawn = yield* onVm(chat.id, (vm) => vm.withdraw(sent));
          if (Option.isNone(withdrawn)) {
            yield* repository.moveInput(chat.id, sent.inputId, ["admitted"], "cancelled");
          }
        }
        yield* publish(chat.id, "inputs");
        const after = yield* repository.input(chat.id, sent.inputId);
        if (after?.state === "materialized") return yield* refuse("already_taken");
      }),

    answer: (input: Payload<"chats.answer">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
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
        const answered = yield* onVm(chat.id, (vm) =>
          vm.putFiles(sent.map((file) => file.id)).pipe(
            Effect.andThen(
              vm.api.client.session.form.reply({
                sessionID: input.sessionId,
                formID: input.formId,
                answer,
              }),
            ),
            Effect.catchTags({
              FormNotFoundError: () => refuse("question_gone"),
              FormAlreadySettledError: () => refuse("question_gone"),
              SessionNotFoundError: () => refuse("question_gone"),
              FormInvalidAnswerError: () => refuse("answer_invalid"),
            }),
          ),
        );
        if (Option.isNone(answered)) return yield* refuse("question_gone");
      }),

    dismiss: (input: Payload<"chats.dismiss">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
        const dismissed = yield* onVm(chat.id, (vm) =>
          vm.api.client.session.form
            .cancel({ sessionID: input.sessionId, formID: input.formId })
            .pipe(
              Effect.catchTags({
                FormNotFoundError: () => refuse("question_gone"),
                FormAlreadySettledError: () => refuse("question_gone"),
                SessionNotFoundError: () => refuse("question_gone"),
              }),
            ),
        );
        if (Option.isNone(dismissed)) return yield* refuse("question_gone");
      }),

    stop: (input: Payload<"chats.stop">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
        yield* requestStop(chat.id);
        yield* runner.cancelWaiting(chat.id);
        yield* runner.wake(chat.id);
      }),

    compact: (input: Payload<"chats.compact">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
        const compacted = yield* onVm(
          chat.id,
          (vm) => vm.api.client.session.compact({ sessionID: vm.root }),
          { boot: true },
        );
        if (Option.isNone(compacted)) return yield* refuse("unavailable");
      }),

    rename: (input: Payload<"chats.rename">, member: Member) =>
      Effect.gen(function* () {
        const chat = yield* commandChat(member, input.chatId);
        yield* repository.rename(chat.id, input.title);
        yield* publish(chat.id, "chat");
        yield* publish(chat.id, "sessions");
        yield* onVm(chat.id, (vm) =>
          vm.api.client.session.update({ sessionID: vm.root, title: input.title }),
        ).pipe(Effect.ignore);
      }),

    delete: Effect.fnUntraced(function* (input: Payload<"chats.delete">, member: Member) {
      const chat = yield* commandChat(member, input.chatId);
      yield* tasks.settle(chat.id, {
        type: "failed",
        reason: "The task's chat was deleted.",
      });
      if (!(yield* repository.markDeleted(chat.id, yield* nowIso))) return;
      yield* sql.afterCommit(
        publish(chat.id, "deleted").pipe(
          Effect.andThen(
            runner
              .stop(chat.id)
              .pipe(
                Effect.andThen(cleanUntilDone(chat.id)),
                Effect.interruptible,
                Effect.forkIn(scope),
              ),
          ),
        ),
      );
    }, transaction),
    start: (hooks: StepHooks, workflows: WorkflowChatHooks | null = null) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(steps, hooks);
        yield* Deferred.succeed(workflowHooks, workflows);
        for (const chatId of yield* repository.pendingDeletes) yield* cleanUntilDone(chatId);
        yield* runner.start(
          {
            ...tasks.hooks,
            instructions: workflowInstructions,
            saved: (chatId, messages, read, reply) =>
              tasks.hooks
                .saved(chatId, messages, read)
                .pipe(Effect.andThen(workflowCalls(chatId, messages, read, reply))),
          },
          (yield* origins.nonterminal).map((task) => task.chatId),
        );
      }),
  };
});

export class ChatService extends Context.Service<ChatService, Effect.Success<typeof make>>()(
  "t45/chats/ChatService",
) {
  static get layer() {
    return layer;
  }
}
const layer = Layer.effect(ChatService, make).pipe(
  Layer.provideMerge(RunnerService.layer),
  Layer.provideMerge(ChatEvents.layer),
);

export const layerTasks = Layer.effect(
  TaskService,
  Effect.map(ChatService, (chats) => chats.tasks),
);
