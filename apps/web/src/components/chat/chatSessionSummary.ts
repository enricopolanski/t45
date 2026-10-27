import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import type { ComposerPromptHistoryMessage } from "../../composerPrompt";
import { chats, type ChatSessionKey, type ChatSessionView } from "../../state/chats";
import { betweenTurns, isShownMessage, promptHistoryOf } from "./chatMessages.logic";

type ReadySession = Extract<ChatSessionView, { status: "ready" }>;

/**
 * A chat session without its messages: what the chat's frame and composer read. It changes
 * only when something they show changes, so streamed words re-render the timeline alone.
 */
export type ChatSessionSummary =
  | Exclude<ChatSessionView, ReadySession>
  | (Omit<ReadySession, "messages"> & {
      readonly hasUserMessages: boolean;
      /** The last message shown is the agent's reply, still streaming. */
      readonly replying: boolean;
      /** The last message shown says the agent stopped on an error. */
      readonly endsWithError: boolean;
      /** The agent is between turns: an input sent now is the next it takes. */
      readonly betweenTurns: boolean;
      /** The member's messages, oldest first, for prompt recall. */
      readonly promptHistory: ReadonlyArray<ComposerPromptHistoryMessage>;
    });

export function summarizeChatSession(view: ChatSessionView): ChatSessionSummary {
  if (view.status !== "ready") return view;
  const { messages, ...rest } = view;
  const shown = messages.filter(isShownMessage);
  const last = shown.at(-1);
  return {
    ...rest,
    hasUserMessages: shown.some((message) => message.message.type === "user"),
    replying: last?.state === "live" && last.message.type === "assistant",
    endsWithError:
      (last?.message.type === "idle" && last.message.outcome === "failed") ||
      (last?.message.type === "assistant" && last.message.error !== undefined),
    betweenTurns: betweenTurns(messages),
    promptHistory: promptHistoryOf(messages),
  };
}

export function sameChatSessionSummary(a: ChatSessionSummary, b: ChatSessionSummary): boolean {
  if (a.status !== "ready" || b.status !== "ready") {
    return (
      a.status === b.status &&
      (a.status !== "failed" || b.status !== "failed" || a.error === b.error)
    );
  }
  const { promptHistory, ...rest } = a;
  const { promptHistory: otherHistory, ...otherRest } = b;
  return (
    Object.entries(rest).every(([key, value]) => Object.is(value, Reflect.get(otherRest, key))) &&
    promptHistory.length === otherHistory.length &&
    promptHistory.every(
      (entry, index) =>
        entry.id === otherHistory[index]?.id && entry.text === otherHistory[index]?.text,
    )
  );
}

const summaryFamily = Atom.family((key: ChatSessionKey) =>
  Atom.make((get) => summarizeChatSession(get(chats.view(key)))).pipe(
    Atom.withEquality(sameChatSessionSummary),
    Atom.withLabel(`chats:summary:${JSON.stringify(key)}`),
  ),
);

export function useChatSessionSummary(key: ChatSessionKey): ChatSessionSummary {
  return useAtomValue(summaryFamily(key));
}
