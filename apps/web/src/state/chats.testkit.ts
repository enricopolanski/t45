import { ChatId } from "@t45/contracts/models/Chat";
import { ChatEvent, ChatMessage, ChatSummary, Question } from "@t45/contracts/resources/Chats";
import * as Schema from "effect/Schema";

/** Native records as the wire encodes them, decoded the way the browser receives them. */
const decodeChatMessage = Schema.decodeUnknownSync(Schema.toCodecJson(ChatMessage));
export const decodeChatEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ChatEvent));
export const decodeChatQuestion = Schema.decodeUnknownSync(Schema.toCodecJson(Question));

export const testChatId = (n: number) =>
  ChatId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

export const CHAT_ID = testChatId(1);
export const ROOT_SESSION = "ses_root";

const decodeChatSummary = Schema.decodeSync(Schema.toCodecJson(ChatSummary));

const chatSummary = (title = "Quarterly report"): ChatSummary =>
  decodeChatSummary({
    id: CHAT_ID,
    agentId: "agent-1",
    agentName: "Analyst",
    title,
    status: null,
    lastActivityAt: "2026-10-01T10:00:00.000Z",
  });

export const CHAT_SUMMARY = chatSummary();

export function userMessage(
  id: string,
  text: string,
  options: { readonly metadata?: unknown; readonly sessionId?: string } = {},
): ChatMessage {
  return decodeChatMessage({
    sessionId: options.sessionId ?? ROOT_SESSION,
    state: "settled",
    isTruncated: false,
    message: {
      id,
      type: "user",
      text,
      time: { created: 1_000 },
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
  });
}

export function assistantMessage(
  id: string,
  content: ReadonlyArray<unknown>,
  options: {
    readonly state?: "live" | "settled" | "lost";
    readonly completed?: boolean;
    readonly error?: unknown;
    readonly sessionId?: string;
  } = {},
): ChatMessage {
  return decodeChatMessage({
    sessionId: options.sessionId ?? ROOT_SESSION,
    state: options.state ?? "settled",
    isTruncated: false,
    message: {
      id,
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content,
      time: { created: 2_000, ...(options.completed === false ? {} : { completed: 3_000 }) },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  });
}

export function nativeMessage(message: Record<string, unknown>, state = "settled"): ChatMessage {
  return decodeChatMessage({
    sessionId: ROOT_SESSION,
    state,
    isTruncated: false,
    message: { time: { created: 1_500 }, ...message },
  });
}

export function snapshotEvent(
  messages: ReadonlyArray<ChatMessage>,
  options: {
    readonly hasEarlier?: boolean;
    readonly title?: string;
    readonly inputs?: ReadonlyArray<unknown>;
    readonly questions?: ReadonlyArray<unknown>;
    readonly sessions?: ReadonlyArray<unknown>;
  } = {},
): ChatEvent {
  return {
    _tag: "snapshot",
    chat: chatSummary(options.title),
    sessions: decodeSessions(options.sessions ?? [{ id: ROOT_SESSION, title: "Root" }]),
    messages,
    hasEarlier: options.hasEarlier ?? false,
    inputs: decodeInputs(options.inputs ?? []),
    questions: (options.questions ?? []).map((question) => decodeChatQuestion(question)),
  };
}

const decodeSessions = (sessions: ReadonlyArray<unknown>) => {
  const event = decodeChatEvent({ _tag: "sessions", sessions });
  return event._tag === "sessions" ? event.sessions : [];
};

const decodeInputs = (inputs: ReadonlyArray<unknown>) => {
  const event = decodeChatEvent({ _tag: "inputs", inputs });
  return event._tag === "inputs" ? event.inputs : [];
};
