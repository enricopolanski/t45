import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ChatAttachment, limitRefusal, MESSAGE_MAX_ATTACHMENTS } from "./Attachment.ts";
import { NonNegativeInt, StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";

/**
 * Chats with agents. T45 keeps the inputs a chat is sent, the OpenCode sessions and messages its
 * executions wrote, in OpenCode's own shapes, and the VM disk the last finished one left. Each
 * execution runs in a new VM booted on that disk, removed once the execution ends.
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
export const ChatStatus = Schema.Literals(["running", "failed", "interrupted"]);
export type ChatStatus = typeof ChatStatus.Type;

export const Report = Schema.Struct({
  message: TrimmedNonEmptyString,
  at: Schema.DateTimeUtcFromString,
});
export type Report = typeof Report.Type;

export class Chat extends Schema.Opaque<Chat>()(
  Schema.Struct({
    id: ChatId,
    agentId: StringId,
    title: Schema.NullOr(Title),
    status: Schema.NullOr(ChatStatus),
    reports: Schema.NullOr(Schema.Array(Report)),
    lastActivityAt: Schema.DateTimeUtcFromString,
  }),
) {}

export const InputPayload = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment).check(
    Schema.makeFilter((attachments) => {
      const ids = attachments.flatMap((attachment) => attachment.contextId ?? []);
      return new Set(ids).size === ids.length;
    }),
  ),
});
export type InputPayload = typeof InputPayload.Type;

export class Input extends Schema.Opaque<Input>()(
  Schema.Struct({
    inputId: InputId,
    ordinal: NonNegativeInt,
    payload: InputPayload,
    createdAt: Schema.DateTimeUtcFromString,
  }),
) {}

export const MESSAGE_MAX_INPUT_CHARS = 120_000;
const UNTITLED = "New chat";

const REFUSALS = {
  id_taken: "Another chat already has this id.",
  input_conflict: "Another message was already sent with this id.",
  agent_unavailable:
    "This agent can't take this chat: it was archived or isn't set up for this work.",
  empty_input: "A message needs text or an attachment.",
  input_too_long: "This message is too long.",
  too_many_files: `You can attach up to ${MESSAGE_MAX_ATTACHMENTS} files per message or question response.`,
  images_too_large:
    "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.",
  file_unavailable: "An attached file is no longer available. Attach it again.",
  already_taken: "The agent already took this message.",
  question_gone: "This question is no longer waiting for an answer.",
  answer_invalid: "This answer doesn't fit the question.",
  answer_files_need_text: "Files can only go with a written answer.",
  unavailable: "The chat's sandbox could not do this right now. Try again.",
  not_running: "This chat is no longer running.",
};
export type Refusal = keyof typeof REFUSALS;

/** A chat request T45 refused or could not carry out; `message` is for people. */
export class Refused extends Schema.TaggedError<Refused>()("ChatRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
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
