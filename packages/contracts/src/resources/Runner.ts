import { ConfigMCP } from "@opencode/schema/config/mcp";
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
    ...Struct.pick(Agent.fields, ["instructions", "model", "permissions"]),
    /** The servers of the agent's app tools, for the VM's OpenCode configuration. */
    mcpServers: Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server)),
    files: FilesByPath(AGENT_SETUP_PATHS),
    /** T45's tools by file name, for `T45_TOOLS_DIR`; none for agents without app tools. */
    tools: Schema.Record(Schema.String, Schema.String),
    skills: Schema.Array(
      Schema.Struct(Struct.pick(Skill.fields, ["name", "description", "content", "files"])),
    ),
  }),
  serverUrl: Schema.String,
  /** The CDP URL of the browser the agent drives, credential included; null without one. */
  webBrowserUrl: Schema.NullOr(Schema.Redacted(Schema.String)),
  rootId: Session.ID,
  title: Schema.String,
  allowQuestions: Schema.Boolean,
  /** The disk the last finished execution left, conversation included; null for a new chat. */
  disk: Schema.NullOr(Schema.Uint8Array),
  /** The messages' files. */
  files: Files,
  messages: Schema.Array(Message),
});
export type ExecutionRequest = typeof ExecutionRequest.Type;

export const ExecutionUpdate = Schema.Union([
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

const question = { rootId: Session.ID, sessionId: Session.ID, formId: Form.ID };

/** One execution per root session at a time; it lasts as long as its `execute` call. */
export const RunnerRpcs = RpcGroup.make(
  Rpc.make("execute", {
    payload: ExecutionRequest,
    success: ExecutionUpdate,
    stream: true,
  }),
  Rpc.make("send", { payload: { rootId: Session.ID, message: Message, files: Files } }),
  Rpc.make("answer", {
    payload: { ...question, answer: Form.Answer, files: Files },
    error: Schema.Union([QuestionGone, AnswerInvalid]),
  }),
  Rpc.make("dismiss", { payload: question, error: QuestionGone }),
  Rpc.make("cancel", { payload: { rootId: Session.ID, messageId: SessionMessage.ID } }),
);
