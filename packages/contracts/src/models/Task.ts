import * as Schema from "effect/Schema";

import { AutomationId } from "./Automation.ts";
import { ChatId } from "./Chat.ts";
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
