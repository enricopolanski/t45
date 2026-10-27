import type { SessionMessage } from "@opencode/client/effect";
import { ChatId, InputId, Refused, type InputPayload } from "@t45/contracts/models/Chat";
import type { Task, Trigger, Outcome, TaskState } from "@t45/contracts/models/Task";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ChatRepository } from "../chats/ChatRepository.ts";
import type { ChatHooks } from "../chats/ChatHooks.ts";
import type { Post } from "../chats/ChatService.ts";

export interface StepHooks {
  readonly canAccess: (ticketId: string, userId: string) => Effect.Effect<"read" | "write" | null>;
  readonly canRun: (task: Task) => Effect.Effect<boolean>;
  readonly prepare: (
    task: Task,
    part: SessionMessage.AssistantTool,
    read: Parameters<ChatHooks["saved"]>[2],
  ) => Effect.Effect<{ readonly apply: Effect.Effect<TaskState | null> } | null>;
  readonly changed: (task: Task) => Effect.Effect<void>;
}

export const make = (
  chats: {
    readonly post: (post: Post) => Effect.Effect<void, Refused | NotFound>;
    readonly requestStop: (chatId: ChatId) => Effect.Effect<void>;
  },
  steps: Effect.Effect<StepHooks>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ChatRepository;
    const origins = repository.origins;
    const crypto = yield* Crypto.Crypto;
    const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));
    const get = (id: ChatId) =>
      origins.get(id).pipe(Effect.map((origin) => (origin?.kind === "task" ? origin : null)));
    const requireTask = (id: ChatId) =>
      get(id).pipe(
        Effect.filterOrFail(
          (task) => task !== null,
          () => new NotFound(),
        ),
      );
    const canRun = (task: Task) =>
      task.trigger.type === "step"
        ? Effect.flatMap(steps, (step) => step.canRun(task))
        : Effect.succeed(true);
    const transition = Effect.fnUntraced(function* (task: Task, state: TaskState) {
      if (task.state.type === "settled") return;
      if (state.type === "settled") yield* chats.requestStop(task.chatId);
      yield* origins.setState(task.chatId, state);
      if (task.trigger.type === "step") yield* (yield* steps).changed({ ...task, state });
    });
    const saved: ChatHooks["saved"] = (chatId, messages, read) =>
      Effect.gen(function* () {
        const initial = yield* get(chatId);
        if (initial?.trigger.type !== "step" || initial.state.type === "settled") return;
        const calls = messages.flatMap((message) =>
          message.type !== "assistant"
            ? []
            : message.content.flatMap((part) =>
                part.type === "tool" && part.state.status === "completed"
                  ? [{ key: `${message.id}/${part.id}`, part }]
                  : [],
              ),
        );
        const recorded = yield* origins.recordedCalls(
          chatId,
          calls.map((call) => call.key),
        );
        const step = yield* steps;
        const prepared = yield* Effect.forEach(
          calls.filter((call) => !recorded.has(call.key)),
          (call) =>
            Effect.map(step.prepare(initial, call.part, read), (effect) => ({ ...call, effect })),
        );
        yield* transaction(
          Effect.gen(function* () {
            const task = yield* requireTask(chatId);
            let state = task.state;
            for (const call of prepared) {
              if (call.effect === null || !(yield* origins.recordCall(chatId, call.key))) continue;
              if (state.type !== "active") continue;
              const next = yield* call.effect.apply;
              if (next === null) continue;
              yield* transition(task, next);
              state = next;
            }
          }).pipe(Effect.orDie),
        );
      });

    return {
      listByTrigger: origins.listByTrigger,
      start: Effect.fnUntraced(function* (
        trigger: Trigger,
        agentId: string,
        brief: { readonly title: string; readonly input: InputPayload },
      ) {
        const chatId = ChatId.make(yield* uuid);
        yield* chats
          .post({
            chatId,
            inputId: InputId.make(yield* uuid),
            from: null,
            input: brief.input,
            start: {
              agentId,
              title: brief.title,
              origin: { kind: "task", chatId, trigger, state: { type: "active" } },
            },
          })
          .pipe(Effect.catchTags({ NotFound: Effect.die }));
        return chatId;
      }, transaction),
      continue: Effect.fnUntraced(function* (
        id: ChatId,
        input: InputPayload,
        sender?: { readonly inputId: InputId; readonly from: string },
      ) {
        const task = yield* requireTask(id);
        const repeated =
          sender !== undefined && (yield* repository.input(id, sender.inputId)) !== null;
        if (!repeated) {
          if (task.state.type === "settled") return yield* new Refused({ reason: "task_settled" });
          if (!(yield* canRun(task))) return yield* new Refused({ reason: "unavailable" });
          yield* origins.setState(id, { type: "active" });
        }
        yield* chats.post({
          chatId: id,
          inputId: sender?.inputId ?? InputId.make(yield* uuid),
          from: sender?.from ?? null,
          input,
        });
      }, transaction),
      requestStop: chats.requestStop,
      settle: Effect.fnUntraced(function* (id: ChatId, outcome: Outcome) {
        const task = yield* get(id);
        if (task !== null) yield* transition(task, { type: "settled", outcome });
      }, transaction),
      hooks: {
        policy: (chatId) =>
          Effect.gen(function* () {
            const origin = yield* origins.get(chatId);
            return {
              questions: origin?.kind === "conversation",
              recover:
                origin?.kind === "task" &&
                origin.state.type === "active" &&
                (yield* canRun(origin)),
            };
          }),
        saved,
        ended: (chatId, status) =>
          transaction(
            Effect.gen(function* () {
              if (status === "running" || status === "waiting" || status === "interrupted") return;
              const task = yield* get(chatId);
              if (
                task?.state.type !== "active" ||
                (yield* repository.hasOpenInputs(chatId)) ||
                !(yield* canRun(task))
              )
                return;
              const outcome: Outcome =
                status === null && task.trigger.type !== "step"
                  ? { type: "succeeded" }
                  : {
                      type: "failed",
                      reason:
                        status === null
                          ? "The agent ended without submitting its work."
                          : "The agent invocation failed.",
                    };
              yield* transition(task, { type: "settled", outcome });
            }),
          ),
      } satisfies ChatHooks,
    };
  });

export class TaskService extends Context.Service<
  TaskService,
  Effect.Success<ReturnType<typeof make>>
>()("t45/tasks/TaskService") {}
