import { Form } from "@opencode/schema/form";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ChatAttachment, MESSAGE_MAX_ATTACHMENTS } from "../models/Attachment.ts";
import {
  Chat,
  ChatId,
  ChatMessageContext,
  Input,
  InputId,
  InputPayload,
  MESSAGE_MAX_INPUT_CHARS,
  Refused,
} from "../models/Chat.ts";
import { StringId, Title } from "../models/primitives.ts";
import { NotFound } from "./errors.ts";

/**
 * What T45 keeps in the native user message an input becomes, under its `metadata`: the input as
 * it was sent, since the agent reads it rewritten.
 */
export const InputMetadata = Schema.Struct({ t45: InputPayload });
export type InputMetadata = typeof InputMetadata.Type;

/** What T45 keeps in the metadata of a note it adds to a chat, and what the note is about. */
export const NoteMetadata = Schema.Struct({
  t45: Schema.Struct({ note: Schema.Literals(["restore", "workspace", "refused"]) }),
});
export type NoteMetadata = typeof NoteMetadata.Type;

const SessionId = Session.ID.check(Schema.isMaxLength(512));

/** One chat as its list shows it; `lastActivityAt` is its latest message, or its creation. */
export const ChatSummary = Schema.Struct({
  ...Chat.fields,
  agentName: Schema.NullOr(Schema.String),
});
export type ChatSummary = typeof ChatSummary.Type;

export const ChatList = Schema.Struct({ chats: Schema.Array(ChatSummary) });
export type ChatList = typeof ChatList.Type;

/** A session of the chat: its root, or a subagent session under it, which members only read. */
export const ChatSession = Session.Info.mapFields(Struct.pick(["id", "parentID", "title"]));
export type ChatSession = typeof ChatSession.Type;

/**
 * A message of a session exactly as OpenCode keeps it. `state` is T45's: `live` while OpenCode is
 * still writing it, `settled` once finished, `lost` when its VM went away before it finished.
 * Reads cut long tool output and text and say so with `isTruncated`; `chats.getMessage` returns
 * it whole.
 */
export const ChatMessage = Schema.Struct({
  sessionId: Session.ID,
  state: Schema.Literals(["live", "settled", "lost"]),
  isTruncated: Schema.Boolean,
  message: SessionMessage.Info,
});
export type ChatMessage = typeof ChatMessage.Type;

/** An input T45 saved that the agent hasn't taken up yet; a member can still cancel it. */
export const PendingInput = Schema.Struct({
  inputId: InputId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdAt: Input.fields.createdAt,
});
export type PendingInput = typeof PendingInput.Type;

/** A question an agent asked in one of the chat's sessions, waiting for an answer. */
export const Question = Schema.Struct({
  sessionId: Session.ID,
  form: Form.Info,
});
export type Question = typeof Question.Type;

/** What `chats.watch` streams for one session of a chat: a snapshot, then changes to it. */
export const ChatEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    chat: ChatSummary,
    sessions: Schema.Array(ChatSession),
    /** The session's latest messages, oldest first. */
    messages: Schema.Array(ChatMessage),
    /** Whether older messages exist; `chats.getHistory` pages them. */
    hasEarlier: Schema.Boolean,
    inputs: Schema.Array(PendingInput),
    questions: Schema.Array(Question),
  }),
  Schema.TaggedStruct("chat", { chat: ChatSummary }),
  Schema.TaggedStruct("sessions", { sessions: Schema.Array(ChatSession) }),
  /** Messages that were added or changed; each replaces the one with its id. */
  Schema.TaggedStruct("messages", { messages: Schema.Array(ChatMessage) }),
  /**
   * Streamed text for a part of a live assistant message: its `ordinal`-th part of `kind`, as
   * OpenCode numbers text and reasoning parts each on their own, not its position in `content`.
   */
  Schema.TaggedStruct("delta", {
    sessionId: Session.ID,
    messageId: SessionMessage.ID,
    ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    kind: Schema.Literals(["text", "reasoning"]),
    delta: Schema.String,
  }),
  Schema.TaggedStruct("inputs", { inputs: Schema.Array(PendingInput) }),
  Schema.TaggedStruct("questions", { questions: Schema.Array(Question) }),
]);
export type ChatEvent = typeof ChatEvent.Type;

/** The page of a session's messages before `before`, oldest first. */
export const ChatHistory = Schema.Struct({
  messages: Schema.Array(ChatMessage),
  hasEarlier: Schema.Boolean,
});
export type ChatHistory = typeof ChatHistory.Type;

export const ChatErrors = Schema.Union([Refused, NotFound]);
export type ChatErrors = typeof ChatErrors.Type;

export const Chats = RpcGroup.make(
  Rpc.make("getHistory", {
    payload: { chatId: ChatId, sessionId: SessionId, before: SessionMessage.ID },
    success: ChatHistory,
    error: ChatErrors,
  }),
  /** One message of a session, whole. */
  Rpc.make("getMessage", {
    payload: { chatId: ChatId, sessionId: SessionId, messageId: SessionMessage.ID },
    success: ChatMessage,
    error: ChatErrors,
  }),
  /**
   * Streams the chats the current user may open, latest activity first: the list, then again after it
   * changes.
   */
  Rpc.make("watchList", {
    success: ChatList,
    stream: true,
  }),
  /**
   * Streams one session of a chat, its root when `sessionId` is absent: a snapshot, then every
   * change to it. Never boots its VM.
   */
  Rpc.make("watch", {
    payload: { chatId: ChatId, sessionId: Schema.optional(SessionId) },
    success: ChatEvent,
    error: ChatErrors,
    stream: true,
  }),
  /** An answer to an agent's question; files go with the answer's text fields, by field key. */
  Rpc.make("answer", {
    payload: {
      chatId: ChatId,
      sessionId: SessionId,
      formId: Form.ID,
      answers: Form.Answer,
      attachments: Schema.Record(Schema.String, Schema.Array(ChatAttachment)),
    },
    error: ChatErrors,
  }),
  Rpc.make("cancel", { payload: { chatId: ChatId, inputId: InputId }, error: ChatErrors }),
  Rpc.make("compact", { payload: { chatId: ChatId }, error: ChatErrors }),
  Rpc.make("delete", { payload: { chatId: ChatId }, error: ChatErrors }),
  Rpc.make("dismiss", {
    payload: { chatId: ChatId, sessionId: SessionId, formId: Form.ID },
    error: ChatErrors,
  }),
  Rpc.make("rename", { payload: { chatId: ChatId, title: Title }, error: ChatErrors }),
  /**
   * A member's message to the chat's agent. T45 saves it before answering, and the agent takes it
   * up when its VM is ready; repeating it with the same `inputId` is a no-op, and with different
   * content an `input_conflict`. The first message starts the current user's chat with `agentId`.
   */
  Rpc.make("send", {
    payload: {
      chatId: ChatId,
      agentId: Schema.optional(StringId),
      inputId: InputId,
      text: Schema.String.check(Schema.isMaxLength(MESSAGE_MAX_INPUT_CHARS)),
      attachments: Schema.Array(ChatAttachment).check(Schema.isMaxLength(MESSAGE_MAX_ATTACHMENTS)),
      context: Schema.optional(ChatMessageContext),
    },
    error: ChatErrors,
  }),
  Rpc.make("stop", { payload: { chatId: ChatId }, error: ChatErrors }),
).prefix("chats.");
