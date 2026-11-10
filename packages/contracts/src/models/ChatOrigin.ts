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
    automationId: AutomationId,
    /** The member who ran the automation on the step. */
    effectiveUserId: StringId,
  }),
]);
export type Trigger = typeof Trigger.Type;

const Conversation = Schema.Struct({
  kind: Schema.Literal("conversation"),
  chatId: ChatId,
  ownerUserId: StringId,
  projectId: Schema.NullOr(StringId),
});
export const AutomationOrigin = Schema.Struct({
  kind: Schema.Literal("automation"),
  chatId: ChatId,
  trigger: Trigger,
});
export type AutomationOrigin = typeof AutomationOrigin.Type;

export const ChatOrigin = Schema.Union([Conversation, AutomationOrigin]);
export type ChatOrigin = typeof ChatOrigin.Type;

/** The user on whose authority a chat's agent runs commands; a run outside a step has none yet. */
export const effectiveUserIdOf = (origin: ChatOrigin) =>
  origin.kind === "conversation"
    ? origin.ownerUserId
    : origin.trigger.type === "step"
      ? origin.trigger.effectiveUserId
      : null;
