/**
 * The ids T45 gives a chat inside OpenCode: its root session and the message each input becomes.
 */
import { Session, SessionMessage } from "@opencode/client/effect";
import { InputId } from "@t45/contracts/models/Chat";
import * as Schema from "effect/Schema";

const encodeId = encodeURIComponent;

/** The root OpenCode session of a chat; its subagents' sessions are OpenCode's. */
export const rootSessionId = (chatId: string) => Session.ID.make(`ses_t45_${encodeId(chatId)}`);

/** The message an input becomes, the same in every execution. */
export const inputMessageId = (chatId: string, inputId: string) =>
  SessionMessage.ID.make(`msg_t45_${encodeId(chatId)}_${encodeId(inputId)}`);

const isInputId = Schema.is(InputId);

export const inputIdOf = (chatId: string, messageId: string) => {
  const prefix = inputMessageId(chatId, "");
  if (!messageId.startsWith(prefix)) return null;
  const tail = messageId.slice(prefix.length);
  return isInputId(tail) ? tail : null;
};
