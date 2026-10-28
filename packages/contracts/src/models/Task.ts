import * as Schema from "effect/Schema";

import { AutomationId } from "./Automation.ts";
import { ChatId, type Chat } from "./Chat.ts";
import { StringId } from "./primitives.ts";

export const Trigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("automation"), automationId: AutomationId }),
  Schema.Struct({
    type: Schema.Literal("step"),
    ticketId: StringId,
    stepId: StringId,
    automationId: StringId,
  }),
]);
export type Trigger = typeof Trigger.Type;

export const Outcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("succeeded") }),
  Schema.Struct({ type: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancelled"), reason: Schema.String }),
]);
export type Outcome = typeof Outcome.Type;

export const TaskState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("active") }),
  Schema.Struct({ type: Schema.Literal("submitted") }),
  Schema.Struct({ type: Schema.Literal("settled"), outcome: Outcome }),
]);
export type TaskState = typeof TaskState.Type;

export const TaskExecution = Schema.Literals([
  "starting",
  "processing",
  "waiting",
  "stopped",
  "finished",
  "failed",
]);
export type TaskExecution = typeof TaskExecution.Type;

/** Task progress survives interruptions; execution reflects the worker and its pending input. */
export const taskExecution = (
  state: TaskState,
  worker: {
    readonly status: Chat["status"];
    readonly awake: boolean;
    readonly queued: boolean;
    readonly stopping: boolean;
  } | null,
): TaskExecution => {
  if (state.type === "submitted") return "finished";
  if (state.type === "settled")
    return state.outcome.type === "succeeded"
      ? "finished"
      : state.outcome.type === "failed"
        ? "failed"
        : "stopped";
  if (worker === null || worker.stopping) return "stopped";
  if (worker.status === "failed") return "failed";
  if (worker.status === "waiting") return "waiting";
  if (worker.queued) return "starting";
  return worker.status === "running" && worker.awake ? "processing" : "stopped";
};

export const Task = Schema.Struct({
  kind: Schema.Literal("task"),
  chatId: ChatId,
  trigger: Trigger,
  state: TaskState,
});
export type Task = typeof Task.Type;

const Conversation = Schema.Struct({
  kind: Schema.Literal("conversation"),
  chatId: ChatId,
  ownerUserId: StringId,
});
export const ChatOrigin = Schema.Union([Conversation, Task]);
export type ChatOrigin = typeof ChatOrigin.Type;
