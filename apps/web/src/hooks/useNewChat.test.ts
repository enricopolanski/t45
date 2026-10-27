import { Agent } from "@t45/contracts/models/Agent";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import { Session } from "@opencode/schema/session";
import type { ChatId } from "@t45/contracts/models/Chat";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFakeApi } from "../../test/fakeApi";
import { chatSessionKey, type ChatSessionKey, type ChatSessionView } from "../state/chats";
import { CHAT_ID, CHAT_SUMMARY, snapshotEvent } from "../state/chats.testkit";
import { openNewChat } from "./useNewChat";

const SUBAGENT = Session.ID.make("ses_child");

it.effect.each([
  { title: "the conversational agent on screen", conversational: true },
  { title: "an eligible fallback for a task-only agent", conversational: false },
])("opens a new chat with $title", ({ conversational }) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeApi;
    const snapshot = snapshotEvent([]);
    const onScreen = chatSessionKey(CHAT_ID, SUBAGENT);
    const viewOf = (key: ChatSessionKey): ChatSessionView =>
      snapshot._tag === "snapshot" && key.chatId === onScreen.chatId && key.sessionId === SUBAGENT
        ? { ...snapshot, status: "ready", loadingEarlier: false, earlierError: null }
        : { status: "loading" };
    const opened: Array<{ readonly chatId: ChatId; readonly agent: string }> = [];
    const router = {
      state: {
        matches: [{ params: { chatId: CHAT_ID } }],
        location: { search: { session: SUBAGENT } },
      },
      navigate: async (options: {
        readonly params: { readonly chatId: ChatId };
        readonly search: { readonly agent: string };
      }) => {
        opened.push({ chatId: options.params.chatId, agent: options.search.agent });
      },
    };

    const opening = yield* openNewChat(router, viewOf).pipe(
      Effect.provide(fake.layer),
      Effect.forkScoped,
    );
    const request = yield* fake.next;
    expect(request.tag).toBe("agents.list");
    const agent = Agent.make({
      id: CHAT_SUMMARY.agentId,
      name: "Analyst",
      instructions: "",
      model: "test/model",
      files: {},
      skills: [],
      mcpServers: {},
      permissions: { network: "provider" },
      status: "active",
      isConversational: conversational,
      createdAt: DateTime.makeUnsafe(0),
      updatedAt: DateTime.makeUnsafe(0),
    });
    request.succeed([
      agent,
      { ...agent, id: "fallback", name: "Assistant", isConversational: true },
    ]);
    yield* Fiber.join(opening);

    expect(opened).toEqual([
      { chatId: expect.any(String), agent: conversational ? CHAT_SUMMARY.agentId : "fallback" },
    ]);
    expect(opened[0]?.chatId).not.toBe(CHAT_ID);
  }).pipe(Effect.scoped),
);
