import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_STREAM_NOT_LOADED,
  applyChatEvent,
  mergeEarlierPages,
  NO_EARLIER_PAGES,
  type ChatSessionView,
  type ChatStreamState,
} from "../../state/chats";
import {
  ROOT_SESSION,
  assistantMessage,
  decodeChatEvent,
  snapshotEvent,
  userMessage,
} from "../../state/chats.testkit";
import { sameChatSessionSummary, summarizeChatSession } from "./chatSessionSummary";

const viewOf = (state: ChatStreamState): ChatSessionView => {
  if (!state.loaded) return { status: "loading" };
  const { loaded: _loaded, ...snapshot } = state;
  return {
    ...snapshot,
    ...mergeEarlierPages(snapshot, NO_EARLIER_PAGES),
    status: "ready",
    loadingEarlier: false,
    earlierError: null,
  };
};

const streaming = applyChatEvent(
  CHAT_STREAM_NOT_LOADED,
  snapshotEvent([
    userMessage("msg_1", "Summarize the report"),
    assistantMessage("msg_2", [{ type: "text", text: "The" }], { state: "live", completed: false }),
  ]),
);

describe("chat session summary", () => {
  it("stays the same while the agent's reply streams", () => {
    const next = applyChatEvent(
      streaming,
      decodeChatEvent({
        _tag: "delta",
        sessionId: ROOT_SESSION,
        messageId: "msg_2",
        ordinal: 0,
        kind: "text",
        delta: " report",
      }),
    );
    const before = summarizeChatSession(viewOf(streaming));
    expect(before).toMatchObject({ status: "ready", replying: true, hasUserMessages: true });
    expect(sameChatSessionSummary(before, summarizeChatSession(viewOf(next)))).toBe(true);
  });

  it("changes when the member sends another message or the reply ends", () => {
    const before = summarizeChatSession(viewOf(streaming));
    const sent = applyChatEvent(streaming, {
      _tag: "messages",
      messages: [userMessage("msg_3", "And the totals?")],
    });
    const after = summarizeChatSession(viewOf(sent));
    expect(sameChatSessionSummary(before, after)).toBe(false);
    expect(after.status === "ready" ? after.promptHistory.map((entry) => entry.text) : []).toEqual([
      "Summarize the report",
      "And the totals?",
    ]);

    const settled = applyChatEvent(streaming, {
      _tag: "messages",
      messages: [assistantMessage("msg_2", [{ type: "text", text: "The report" }])],
    });
    expect(summarizeChatSession(viewOf(settled))).toMatchObject({ replying: false });
  });
});
