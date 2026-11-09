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
  }),
]);
export type Trigger = typeof Trigger.Type;

const Conversation = Schema.Struct({
  kind: Schema.Literal("conversation"),
  chatId: ChatId,
  ownerUserId: StringId,
  workflowId: Schema.NullOr(StringId),
});
export const AutomationOrigin = Schema.Struct({
  kind: Schema.Literal("automation"),
  chatId: ChatId,
  trigger: Trigger,
});
export type AutomationOrigin = typeof AutomationOrigin.Type;

export const ChatOrigin = Schema.Union([Conversation, AutomationOrigin]);
export type ChatOrigin = typeof ChatOrigin.Type;
