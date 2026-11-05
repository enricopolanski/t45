import { Form } from "@opencode/schema/form";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Agent, AGENT_SETUP_PATHS } from "../models/Agent.ts";
import { FilesByPath } from "../models/primitives.ts";
import { Skill } from "../models/Skill.ts";

/** Files by their path under /work. */
const Files = Schema.Record(Schema.String, Schema.Uint8Array);

export const Message = Schema.Struct({
  id: SessionMessage.ID,
  ...Struct.pick(SessionInbox.UserPayload.fields, ["text", "metadata"]),
});
export type Message = typeof Message.Type;

export const ExecutionRequest = Schema.Struct({
  agent: Schema.Struct({
    ...Struct.pick(Agent.fields, ["instructions", "model", "mcpServers", "permissions"]),
    files: FilesByPath(AGENT_SETUP_PATHS),
    skills: Schema.Array(
      Schema.Struct(Struct.pick(Skill.fields, ["name", "description", "content", "files"])),
    ),
  }),
  root: Session.ID,
  title: Schema.String,
  questions: Schema.Boolean,
  /** The disk the last finished execution left, conversation included; null for a new chat. */
  disk: Schema.NullOr(Schema.Uint8Array),
  /** The messages' files. */
  files: Files,
  messages: Schema.Array(Message),
});
export type ExecutionRequest = typeof ExecutionRequest.Type;

export const ExecutionUpdate = Schema.Union([
  /** The root and every session under it, parents first. */
  Schema.TaggedStruct("sessions", { sessions: Schema.Array(Session.Info) }),
  Schema.TaggedStruct("messages", {
    sessionId: Session.ID,
    messages: Schema.Array(SessionMessage.Info),
  }),
  Schema.TaggedStruct("delta", {
    sessionId: Session.ID,
    messageId: SessionMessage.ID,
    ordinal: Schema.Int,
    kind: Schema.Literals(["text", "reasoning"]),
    delta: Schema.String,
  }),
  Schema.TaggedStruct("questions", { forms: Schema.Array(Form.Info) }),
  /** Before the messages that name it. */
  Schema.TaggedStruct("file", { path: Schema.String, content: Schema.Uint8Array }),
  /** The sandbox was lost: everything since the execution started is void, and a new sandbox starts over. */
  Schema.TaggedStruct("restarted", {}),
  /** Keeps the call's connection from going idle while the agent waits. */
  Schema.TaggedStruct("heartbeat", {}),
  Schema.TaggedStruct("finished", {
    outcome: Schema.NullOr(Schema.Literal("failed")),
    disk: Schema.Uint8Array,
  }),
]);
export type ExecutionUpdate = typeof ExecutionUpdate.Type;

/** Whether OpenCode finished writing the message. */
export const isSettled = (message: SessionMessage.Info) => {
  switch (message.type) {
    case "assistant":
      return message.time.completed !== undefined;
    case "shell":
    case "compaction":
      return message.status !== "running";
    default:
      return true;
  }
};

export class QuestionGone extends Schema.TaggedError<QuestionGone>()("QuestionGone", {}) {}

export class AnswerInvalid extends Schema.TaggedError<AnswerInvalid>()("AnswerInvalid", {}) {}

const question = { id: Schema.String, sessionId: Session.ID, formId: Form.ID };

/** One execution per `id` at a time; it lasts as long as its `execute` call. */
export const RunnerRpcs = RpcGroup.make(
  Rpc.make("execute", {
    payload: { id: Schema.String, request: ExecutionRequest },
    success: ExecutionUpdate,
    stream: true,
  }),
  Rpc.make("send", { payload: { id: Schema.String, message: Message, files: Files } }),
  Rpc.make("answer", {
    payload: { ...question, answer: Form.Answer, files: Files },
    error: Schema.Union([QuestionGone, AnswerInvalid]),
  }),
  Rpc.make("dismiss", { payload: question, error: QuestionGone }),
  Rpc.make("cancel", { payload: { id: Schema.String, messageId: SessionMessage.ID } }),
);
