/**
 * The ids T45 gives a chat inside OpenCode: its root session, the message each input is admitted
 * as, and the notes T45 adds to it.
 */
import { Session, SessionMessage } from "@opencode/client/effect";
import { InputId } from "@t45/contracts/models/Chat";
import type { NoteMetadata } from "@t45/contracts/resources/Chats";
import * as Schema from "effect/Schema";

const encodeId = encodeURIComponent;

/** The root OpenCode session of a chat; its subagents' sessions are OpenCode's. */
export const rootSessionId = (chatId: string) => Session.ID.make(`ses_t45_${encodeId(chatId)}`);

/** The message an input is admitted as, so a retried prompt finds the first one. */
export const inputMessageId = (chatId: string, inputId: string) =>
  SessionMessage.ID.make(`msg_t45_${encodeId(chatId)}_${encodeId(inputId)}`);

const isInputId = Schema.is(InputId);

export const inputIdOf = (chatId: string, messageId: string) => {
  const prefix = inputMessageId(chatId, "");
  if (!messageId.startsWith(prefix)) return null;
  const tail = messageId.slice(prefix.length);
  return isInputId(tail) ? tail : null;
};

type NoteKind = NoteMetadata["t45"]["note"];

/** A note T45 adds to the chat. The `.` keeps it apart from every input's id. */
export const noteMessageId = (chatId: string, kind: NoteKind, key: string) =>
  SessionMessage.ID.make(`msg_t45_${encodeId(chatId)}_${kind}.${encodeId(key)}`);

/** Whether `id` names a note of `kind` T45 added to the chat. */
export const isNoteOf = (chatId: string, kind: NoteKind, id: string) =>
  id.startsWith(noteMessageId(chatId, kind, ""));
