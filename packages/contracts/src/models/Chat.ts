import * as Schema from "effect/Schema";

import {
  AttachmentId,
  ChatAttachment,
  limitRefusal,
  MESSAGE_MAX_ATTACHMENTS,
} from "./Attachment.ts";
import { NonNegativeInt, StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";

/**
 * Chats with agents. T45 keeps each chat: its OpenCode sessions and messages in OpenCode's own
 * shapes, the inputs it is sent, and the agent's workspace. The agent runs in a VM that keeps
 * nothing: T45 boots one when the chat has work, restores the chat into it, and removes it once
 * the chat is idle and saved.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const ChatId = Schema.String.check(Schema.isPattern(UUID)).pipe(Schema.brand("ChatId"));
export type ChatId = typeof ChatId.Type;

/** An input's id, chosen by its sender so a retry can't send it twice. */
export const InputId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type InputId = typeof InputId.Type;

/** What a chat is doing; null when it is idle. */
export const ChatStatus = Schema.Literals(["running", "waiting", "failed", "interrupted"]);
export type ChatStatus = typeof ChatStatus.Type;

export class Chat extends Schema.Opaque<Chat>()(
  Schema.Struct({
    id: ChatId,
    agentId: StringId,
    title: Schema.NullOr(Title),
    status: Schema.NullOr(ChatStatus),
    lastActivityAt: Schema.DateTimeUtcFromString,
  }),
) {}

const CONTEXT_ID_MAX_CHARS = 128;
const CONTEXT_ID_PATTERN = /^[a-z0-9_-]+$/i;

export const CHAT_CONTEXT_LABEL_MAX_CHARS = 200;

/** Durable identity of one payload, shared by every reference to it. */
export const ChatContextId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CONTEXT_ID_MAX_CHARS),
  Schema.isPattern(CONTEXT_ID_PATTERN),
).pipe(Schema.brand("ChatContextId"));
export type ChatContextId = typeof ChatContextId.Type;

export const ChatContextKind = Schema.Literals(["image", "file"]);
export type ChatContextKind = typeof ChatContextKind.Type;

const ContextLabel = Schema.String.check(Schema.isMaxLength(CHAT_CONTEXT_LABEL_MAX_CHARS));

/** An image or file referenced in a message, bound to its attachment by id. */
export const ChatContextRecord = Schema.Struct({
  contextId: ChatContextId,
  label: ContextLabel,
  kind: ChatContextKind,
  attachmentId: AttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatContextRecord = typeof ChatContextRecord.Type;

const CHAT_CONTEXT_MAX_RECORDS = 200;

/** Structured context riding on a user message. */
export const ChatMessageContext = Schema.Struct({
  records: Schema.Array(ChatContextRecord).check(
    Schema.isMaxLength(CHAT_CONTEXT_MAX_RECORDS),
    Schema.makeFilter(
      (records) => new Set(records.map((record) => record.contextId)).size === records.length,
    ),
  ),
});
export type ChatMessageContext = typeof ChatMessageContext.Type;

export const InputPayload = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  context: Schema.optional(ChatMessageContext),
});
export type InputPayload = typeof InputPayload.Type;

const InputState = Schema.Literals(["waiting", "admitted", "materialized", "cancelled"]);
export type InputState = typeof InputState.Type;

export class Input extends Schema.Opaque<Input>()(
  Schema.Struct({
    inputId: InputId,
    ordinal: NonNegativeInt,
    state: InputState,
    payload: InputPayload,
    createdAt: Schema.DateTimeUtcFromString,
  }),
) {}

export const MESSAGE_MAX_INPUT_CHARS = 120_000;
const UNTITLED = "New chat";

const REFUSALS = [
  "id_taken",
  "input_conflict",
  "agent_unavailable",
  "empty_input",
  "input_too_long",
  "too_many_files",
  "images_too_large",
  "file_unavailable",
  "already_taken",
  "question_gone",
  "answer_invalid",
  "answer_files_need_text",
  "unavailable",
  "task_settled",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/** A chat request T45 refused or could not carry out; `message` is for people. */
export class Refused extends Schema.TaggedError<Refused>()("ChatRefused", {
  reason: Schema.Literals(REFUSALS),
}) {
  override get message(): string {
    switch (this.reason) {
      case "id_taken":
        return "Another chat already has this id.";
      case "input_conflict":
        return "Another message was already sent with this id.";
      case "agent_unavailable":
        return "This agent can't take this chat: it was archived or isn't set up for this work.";
      case "empty_input":
        return "A message needs text or an attachment.";
      case "input_too_long":
        return "This message is too long.";
      case "too_many_files":
        return `You can attach up to ${MESSAGE_MAX_ATTACHMENTS} files per message or question response.`;
      case "images_too_large":
        return "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.";
      case "file_unavailable":
        return "An attached file is no longer available. Attach it again.";
      case "already_taken":
        return "The agent already took this message.";
      case "question_gone":
        return "This question is no longer waiting for an answer.";
      case "answer_invalid":
        return "This answer doesn't fit the question.";
      case "answer_files_need_text":
        return "Files can only go with a written answer.";
      case "task_settled":
        return "This task has ended. Start a new task to try again.";
      case "unavailable":
        return "The chat's sandbox could not do this right now. Try again.";
    }
  }
}

export const inputRefusal = (input: InputPayload, promptLength: number) =>
  input.text.trim() === "" && input.attachments.length === 0
    ? "empty_input"
    : promptLength > MESSAGE_MAX_INPUT_CHARS
      ? "input_too_long"
      : limitRefusal(input.attachments);

export const titleFromText = (
  plainText: string,
  attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>,
) => {
  const image = attachments.find((attachment) => attachment.type === "image");
  const file = attachments.find((attachment) => attachment.type === "file");
  const text = plainText.trim();
  const seed = text || (image ? `Image: ${image.name}` : file ? `File: ${file.name}` : UNTITLED);
  return seed.length <= 50 ? seed : `${seed.slice(0, 50)}...`;
};

export const titleOf = (chat: Pick<Chat, "title">) => chat.title ?? UNTITLED;
