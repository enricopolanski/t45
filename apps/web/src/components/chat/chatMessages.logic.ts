import { type ChatAttachment } from "@t45/contracts/models/Attachment";
import { type ChatMessage, InputMetadata, NoteMetadata } from "@t45/contracts/resources/Chats";
import { type ChatMessageContext } from "@t45/contracts/models/Chat";
import { WORKFLOW_DRAFT_TOOL_NAME, WorkflowDraft } from "@t45/contracts/resources/AgentTools";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ComposerPromptHistoryMessage } from "../../composerPrompt";
import type { NativeAssistantMessage, NativeMessage, NativeToolPart } from "../../state/chats";

/**
 * T45's part of a member's message, under its metadata: the text as they wrote it (the agent
 * gets it rewritten), the attachments and the chips binding them.
 */
const decodeInputMetadata = Schema.decodeUnknownOption(InputMetadata);

export interface UserMessageContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: ChatMessageContext | undefined;
}

type UserMessage = Extract<NativeMessage, { type: "user" }>;

const contentByMessage = new WeakMap<UserMessage, UserMessageContent>();

/** A member's message as they sent it; one T45 didn't send reads as OpenCode keeps it. */
export function userMessageContent(message: UserMessage): UserMessageContent {
  const known = contentByMessage.get(message);
  if (known) return known;
  const content = Option.match(decodeInputMetadata(message.metadata), {
    onNone: () => ({ text: message.text, attachments: [], context: undefined }),
    onSome: ({ t45 }) => ({ text: t45.text, attachments: t45.attachments, context: t45.context }),
  });
  contentByMessage.set(message, content);
  return content;
}

/** The member's messages of a session, oldest first, as the composer recalls them. */
export function promptHistoryOf(
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ComposerPromptHistoryMessage> {
  return messages.flatMap(({ message }) =>
    message.type === "user" ? [{ id: message.id, text: userMessageContent(message).text }] : [],
  );
}

const isNoteMetadata = Schema.is(NoteMetadata);

/**
 * Whether the agent is between turns after `messages`, oldest first: it has had none, its last
 * one ended, or T45 added a note since, which starts none.
 */
export function betweenTurns(messages: ReadonlyArray<ChatMessage>): boolean {
  const last = messages.at(-1)?.message;
  return (
    last === undefined ||
    last.type === "idle" ||
    (last.type === "synthetic" && isNoteMetadata(last.metadata))
  );
}

/** Whether the timeline shows the message at all: bookkeeping rows say nothing to members. */
export function isShownMessage({ message, state }: ChatMessage): boolean {
  switch (message.type) {
    case "idle":
      return message.outcome !== "succeeded";
    case "location-switched":
      return false;
    case "assistant":
      return state !== "settled" || message.content.length > 0 || message.error !== undefined;
    default:
      return true;
  }
}

/** The assistant's prose, for copying it. */
export function assistantText(message: NativeAssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

const decodeDraft = Schema.decodeUnknownOption(WorkflowDraft);

/**
 * Whether the part is a workflow a chat agent drafted with the draft tool, shown as a card. A
 * refused draft is an errored tool call: it stays a tool row, since the agent was told what to
 * fix and drafts again.
 */
export function isWorkflowDraftCall(part: NativeToolPart): boolean {
  return part.name === WORKFLOW_DRAFT_TOOL_NAME && part.state.status === "completed";
}

/** The workflow a draft tool call holds, or null when it holds none. */
export function workflowDraftOf(part: NativeToolPart): WorkflowDraft | null {
  if (!isWorkflowDraftCall(part)) return null;
  return Option.getOrNull(decodeDraft(part.state.input));
}

/** The session a subagent tool call runs in, once OpenCode has reported it. */
export function subagentSessionId(part: NativeToolPart): string | null {
  if (part.name !== "subagent" || part.state.status === "streaming") return null;
  const sessionId = part.state.metadata?.["sessionID"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

const TOOL_SUBJECT_KEYS = [
  "description",
  "command",
  "filePath",
  "path",
  "pattern",
  "url",
  "query",
] as const;

/** A tool call's one-line label: its name and what it acted on. */
export function toolLabel(part: NativeToolPart): {
  readonly name: string;
  readonly subject: string | null;
} {
  const input = part.state.status === "streaming" ? null : part.state.input;
  const subject = input
    ? TOOL_SUBJECT_KEYS.map((key) => input[key]).find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : undefined;
  return {
    name: part.name === "subagent" ? "Subagent" : part.name,
    subject: subject === undefined ? null : firstLine(subject, 160),
  };
}

export function firstLine(text: string, max = Number.POSITIVE_INFINITY): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const TOOL_OUTPUT_PREVIEW_CHARS = 4_000;

/**
 * What a tool call produced so far, cut to a bounded preview: its text output and the files it
 * returned, its error, or for a call still running the input it was given.
 */
export function toolOutputText(part: NativeToolPart): string {
  const state = part.state;
  const content =
    state.status === "completed" || state.status === "error"
      ? (state.content ?? []).map((item) =>
          item.type === "text" ? item.text : `[${item.name ?? item.uri}]`,
        )
      : [];
  const parts =
    state.status === "error"
      ? [state.error.message, ...content]
      : state.status === "completed"
        ? content
        : state.status === "running"
          ? [boundedJson(state.input)]
          : [state.input];
  return parts.join("\n").trim();
}

/** `text` cut to `max` characters, and whether anything was cut. */
export function boundText(text: string, max = TOOL_OUTPUT_PREVIEW_CHARS) {
  return text.length <= max
    ? { text, cut: false }
    : { text: `${text.slice(0, max).trimEnd()}\n…`, cut: true };
}

/** JSON for a value of unknown size: traversal is bounded before encoding. */
function boundedJson(value: unknown): string {
  let remaining = 24_000;
  let nodes = 200;
  const seen = new WeakSet<object>();
  const text = (input: string) => {
    const result = input.slice(0, Math.max(0, Math.min(remaining, 4_000)));
    remaining -= result.length;
    return result.length < input.length ? `${result}…` : result;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (nodes-- <= 0 || remaining <= 0 || depth > 6) return "…";
    if (typeof input === "string") return text(input);
    if (typeof input !== "object" || input === null) return input;
    if (seen.has(input)) return "…";
    seen.add(input);
    if (Array.isArray(input)) {
      return input
        .slice(0, 20)
        .map((item) => visit(item, depth + 1))
        .concat(input.length > 20 ? ["…"] : []);
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(input)) {
      if (count++ >= 20 || nodes <= 0 || remaining <= 0) {
        result["…"] = "Preview shortened";
        break;
      }
      result[text(key)] = visit(entry, depth + 1);
    }
    return result;
  };
  return JSON.stringify(visit(value, 0), null, 2) ?? "";
}
