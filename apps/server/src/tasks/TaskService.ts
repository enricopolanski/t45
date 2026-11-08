import type { Receive } from "../chats/ChatExecutions.ts";
import type { SessionMessage } from "@opencode/schema/session-message";
import { ChatId, InputId, type InputPayload } from "@t45/contracts/models/Chat";
import type { Task, Trigger, Outcome } from "@t45/contracts/models/Task";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ChatRepository } from "../chats/ChatRepository.ts";
import { ChatService } from "../chats/ChatService.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import { TicketRepository } from "../workflows/TicketRepository.ts";
import { isActionable } from "@t45/contracts/models/Workflow";

export interface StepHooks {
  readonly prepare: (
    task: Task,
    part: SessionMessage.AssistantTool,
    generated: ReadonlyMap<string, Uint8Array>,
  ) => Effect.Effect<{ readonly apply: Effect.Effect<Outcome | null> } | null>;
  readonly changed: (task: Task) => Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const chats = yield* ChatService;
  const tickets = yield* TicketRepository;
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
  const changes = yield* (yield* ChatEvents).subscribe(
    (change) => change.kind === "chat" || change.kind === "posted" || change.kind === "deleted",
  );
  yield* changes.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        if (change.kind === "missed") return yield* tickets.publishChange();
        const task = yield* get(change.chatId);
        if (task?.trigger.type === "step") yield* tickets.publishChange(task.trigger.ticketId);
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.logWarning("Forwarding a chat change to step views failed", {
            change,
            cause,
          }).pipe(Effect.andThen(tickets.publishChange())),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  const canRun = (task: Task) =>
    Effect.gen(function* () {
      if (task.trigger.type !== "step") return true;
      const trigger = task.trigger;
      const ticket = yield* tickets.get(trigger.ticketId);
      const step = ticket?.steps.find((step) => step.id === trigger.stepId);
      return (
        ticket?.status.type === "open" &&
        step !== undefined &&
        isActionable(step) &&
        step.automations.some((entry) => entry.id === trigger.automationId)
      );
    });
  const settleTask = Effect.fnUntraced(function* (task: Task, outcome: Outcome) {
    if (task.state.type === "settled") return null;
    const state = { type: "settled", outcome } as const;
    yield* origins.setState(task.chatId, state);
    yield* chats.remove(task.chatId);
    if (task.trigger.type === "step") yield* tickets.publishChange(task.trigger.ticketId);
    return { ...task, state };
  });
  const saved = (
    chatId: ChatId,
    messages: ReadonlyArray<SessionMessage.Info>,
    generated: Parameters<StepHooks["prepare"]>[2],
    step: StepHooks,
  ) =>
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
      const prepared = yield* Effect.forEach(
        calls.filter((call) => !recorded.has(call.key)),
        (call) =>
          Effect.map(step.prepare(initial, call.part, generated), (effect) => ({
            ...call,
            effect,
          })),
      );
      yield* transaction(
        Effect.gen(function* () {
          const task = yield* requireTask(chatId);
          let isSettled = task.state.type === "settled";
          for (const call of prepared) {
            if (call.effect === null || !(yield* origins.recordCall(chatId, call.key))) continue;
            if (isSettled) continue;
            const outcome = yield* call.effect.apply;
            if (outcome === null) continue;
            const settled = yield* settleTask(task, outcome);
            if (settled !== null) yield* step.changed(settled);
            isSettled = true;
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
    requestStop: chats.requestStop,
    settle: Effect.fnUntraced(function* (id: ChatId, outcome: Outcome) {
      const task = yield* get(id);
      if (task !== null) yield* settleTask(task, outcome);
    }, transaction),
    receive: (result: Parameters<Receive>[0], steps: StepHooks) => {
      const { chatId } = result;
      if (result.type === "messages")
        return saved(chatId, result.messages, result.generated, steps);
      return transaction(
        Effect.gen(function* () {
          const task = yield* get(chatId);
          if (task?.state.type !== "active" || !(yield* canRun(task))) return;
          const outcome: Outcome =
            result.status === null && task.trigger.type !== "step"
              ? { type: "succeeded" }
              : {
                  type: "failed",
                  reason:
                    result.status === null
                      ? "The agent ended without submitting its work."
                      : "The agent invocation failed.",
                };
          const settled = yield* settleTask(task, outcome);
          if (settled !== null) yield* steps.changed(settled);
        }),
      );
    },
  };
});

export class TaskService extends Context.Service<TaskService, Effect.Success<typeof make>>()(
  "t45/tasks/TaskService",
) {
  static get layer() {
    return layer;
  }
}
const layer = Layer.effect(TaskService, make);
