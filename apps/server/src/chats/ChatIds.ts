/**
 * The ids T45 gives a chat inside OpenCode: its root session and the message each input becomes.
 */
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";

/** The root OpenCode session of a chat; its subagents' sessions are OpenCode's. */
export const rootSessionId = (chatId: string) => Session.ID.make(`ses_t45_${chatId}`);

/** The message an input becomes, the same in every execution. */
export const inputMessageId = (chatId: string, inputId: string) =>
  SessionMessage.ID.make(`msg_t45_${chatId}_${inputId}`);

/** Whether the message is one an input of the chat became. */
export const isInputMessage = (chatId: string, messageId: string) =>
  messageId.startsWith(inputMessageId(chatId, ""));
