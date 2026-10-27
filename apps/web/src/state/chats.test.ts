import type { ChatEvent, ChatHistory } from "@t45/contracts/resources/Chats";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";

import { installBrowserEvents, makeFakeApi } from "../../test/fakeApi";
import {
  CHAT_STREAM_NOT_LOADED,
  applyChatEvent,
  createChatAtoms,
  mergeEarlierPages,
  NO_EARLIER_PAGES,
  prependEarlierPage,
  type ChatStreamState,
  type ChatSessionView,
} from "./chats";
import {
  CHAT_ID,
  ROOT_SESSION,
  assistantMessage,
  decodeChatEvent,
  snapshotEvent,
  userMessage,
} from "./chats.testkit";

const fold = (events: ReadonlyArray<ChatEvent>): ChatStreamState =>
  events.reduce(applyChatEvent, CHAT_STREAM_NOT_LOADED);

const loaded = (state: ChatStreamState) => {
  if (!state.loaded) throw new Error("The chat has no snapshot yet.");
  return state;
};

const ids = (messages: ReadonlyArray<{ readonly message: { readonly id: string } }>) =>
  messages.map((message) => message.message.id);

const delta = (messageId: string, ordinal: number, text: string, kind = "text") =>
  decodeChatEvent({
    _tag: "delta",
    sessionId: ROOT_SESSION,
    messageId,
    ordinal,
    kind,
    delta: text,
  });

const live = (id: string, content: ReadonlyArray<unknown>) =>
  assistantMessage(id, content, { state: "live", completed: false });

describe("applyChatEvent", () => {
  it("ignores changes until the snapshot arrives, then replaces everything with each snapshot", () => {
    const early = applyChatEvent(CHAT_STREAM_NOT_LOADED, {
      _tag: "messages",
      messages: [userMessage("msg_1", "hi")],
    });
    expect(early.loaded).toBe(false);

    const first = fold([snapshotEvent([userMessage("msg_1", "hi")], { title: "First" })]);
    const second = applyChatEvent(first, snapshotEvent([userMessage("msg_2", "again")]));
    expect(ids(loaded(second).messages)).toEqual(["msg_2"]);
    expect(loaded(second).chat.title).toBe("Quarterly report");
  });

  it("replaces a message by id in place and appends a new one at the end", () => {
    const state = fold([
      snapshotEvent([userMessage("msg_1", "hi"), live("msg_2", [])]),
      {
        _tag: "messages",
        messages: [
          assistantMessage("msg_2", [{ type: "text", text: "done" }]),
          userMessage("msg_3", "next"),
        ],
      },
    ]);
    const messages = loaded(state).messages;
    expect(ids(messages)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(messages[1]?.state).toBe("settled");
  });

  it("appends streamed text to its part by kind and order, adding the next part of a kind", () => {
    // OpenCode numbers text parts and reasoning parts each from 0.
    const state = fold([
      snapshotEvent([live("msg_1", [{ type: "reasoning", text: "Think" }])]),
      delta("msg_1", 0, "ing", "reasoning"),
      delta("msg_1", 0, "Hel"),
      delta("msg_1", 0, "lo"),
      delta("msg_1", 1, "Check", "reasoning"),
      delta("msg_1", 1, "Done"),
      delta("msg_1", 0, ".", "reasoning"),
    ]);
    const message = loaded(state).messages[0]?.message;
    expect(message?.type === "assistant" ? message.content : null).toEqual([
      { type: "reasoning", text: "Thinking." },
      { type: "text", text: "Hello" },
      { type: "reasoning", text: "Check" },
      { type: "text", text: "Done" },
    ]);
  });

  it("leaves deltas for finished messages and parts further on to the next full copy", () => {
    const start = fold([
      snapshotEvent([
        live("msg_live", [{ type: "text", text: "a" }]),
        assistantMessage("msg_done", [{ type: "text", text: "final" }]),
      ]),
    ]);
    for (const event of [
      delta("msg_done", 0, "x"),
      delta("msg_live", 3, "x"),
      delta("msg_live", 1, "x", "reasoning"),
    ]) {
      expect(applyChatEvent(start, event)).toBe(start);
    }
  });

  it("keeps the text streamed past a live message's copy until the copy catches up", () => {
    const streamed = fold([
      snapshotEvent([live("msg_1", [])]),
      delta("msg_1", 0, "Hello"),
      // OpenCode's copy holds a part's text only once the part ends.
      { _tag: "messages", messages: [live("msg_1", [{ type: "text", text: "" }])] },
    ]);
    const text = (state: ChatStreamState) => {
      const message = loaded(state).messages[0]?.message;
      return message?.type === "assistant" ? message.content : null;
    };
    expect(text(streamed)).toEqual([{ type: "text", text: "Hello" }]);
    // A reconnect's snapshot keeps it too.
    const reconnected = applyChatEvent(
      streamed,
      snapshotEvent([live("msg_1", [{ type: "text", text: "" }])]),
    );
    expect(text(reconnected)).toEqual([{ type: "text", text: "Hello" }]);
    const ended = applyChatEvent(reconnected, {
      _tag: "messages",
      messages: [live("msg_1", [{ type: "text", text: "Hello there" }])],
    });
    expect(text(ended)).toEqual([{ type: "text", text: "Hello there" }]);
    const settled = applyChatEvent(ended, {
      _tag: "messages",
      messages: [assistantMessage("msg_1", [{ type: "text", text: "Hi" }])],
    });
    expect(text(settled)).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("takes a part's text from a copy once the part ended, whatever streamed late", () => {
    // A copy read after the part ended reached the browser before deltas streamed earlier.
    const state = fold([
      snapshotEvent([live("msg_1", [{ type: "text", text: "Let me check." }])]),
      delta("msg_1", 0, "check."),
      { _tag: "messages", messages: [live("msg_1", [{ type: "text", text: "Let me check." }])] },
    ]);
    const message = loaded(state).messages[0]?.message;
    expect(message?.type === "assistant" ? message.content : null).toEqual([
      { type: "text", text: "Let me check." },
    ]);
  });

  it("holds what streams for a message it has no copy of yet, until its first copy", () => {
    const state = fold([
      snapshotEvent([userMessage("msg_1", "hi")]),
      delta("msg_2", 0, "Hel"),
      delta("msg_2", 0, "lo"),
    ]);
    expect(ids(loaded(state).messages)).toEqual(["msg_1"]);
    const copied = applyChatEvent(state, {
      _tag: "messages",
      messages: [live("msg_2", [{ type: "text", text: "" }])],
    });
    const message = loaded(copied).messages[1]?.message;
    expect(message?.type === "assistant" ? message.content : null).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });
});

describe("earlier pages", () => {
  const window = {
    messages: [userMessage("msg_3", "c"), userMessage("msg_4", "d")],
    hasEarlier: true,
  };
  const page = (messages: ChatHistory["messages"], hasEarlier: boolean): ChatHistory => ({
    messages,
    hasEarlier,
  });

  it("puts loaded pages in front of the window, oldest first, without repeating a message", () => {
    const first = prependEarlierPage(
      window,
      NO_EARLIER_PAGES,
      window.messages[0]!.message.id,
      page([userMessage("msg_2", "b"), userMessage("msg_3", "c")], true),
    );
    const second = prependEarlierPage(
      window,
      first,
      first.messages[0]!.message.id,
      page([userMessage("msg_1", "a")], false),
    );
    const merged = mergeEarlierPages(window, second);
    expect(ids(merged.messages)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(merged.hasEarlier).toBe(false);
  });

  it("drops a page that no longer joins the loaded messages", () => {
    const stale = prependEarlierPage(
      window,
      NO_EARLIER_PAGES,
      "msg_9" as (typeof window.messages)[number]["message"]["id"],
      page([userMessage("msg_1", "a")], false),
    );
    expect(stale).toBe(NO_EARLIER_PAGES);
  });

  it("stops showing pages once a snapshot moved the window past them", () => {
    const pages = prependEarlierPage(
      window,
      NO_EARLIER_PAGES,
      window.messages[0]!.message.id,
      page([userMessage("msg_2", "b")], false),
    );
    const moved = { messages: [userMessage("msg_7", "g")], hasEarlier: true };
    expect(mergeEarlierPages(moved, pages)).toEqual(moved);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const makeHarness = Effect.fn("TestChatAtoms.makeHarness")(function* () {
  installBrowserEvents();
  const fake = yield* makeFakeApi;
  const atoms = createChatAtoms(fake.atomRuntime);
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const view = atoms.view({ chatId: CHAT_ID });
  yield* AtomRegistry.mount(registry, view);
  /** Waits for the view to reach a state, as each event lands. */
  const viewWhere = <A extends ChatSessionView>(predicate: (view: ChatSessionView) => view is A) =>
    AtomRegistry.toStream(registry, view).pipe(Stream.filter(predicate), Stream.runHead);
  return { atoms, fake, registry, viewWhere };
});

const isReady = (view: ChatSessionView): view is Extract<ChatSessionView, { status: "ready" }> =>
  view.status === "ready";

describe("chat atoms", () => {
  it.effect("folds the open stream into the view and pages history in front of it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const watch = yield* harness.fake.next;
        expect(watch).toMatchObject({ tag: "chats.watch", payload: { chatId: CHAT_ID } });
        watch.items([
          snapshotEvent([userMessage("msg_3", "c"), live("msg_4", [])], { hasEarlier: true }),
          delta("msg_4", 0, "Hi"),
        ]);
        const streamed = yield* harness.viewWhere(
          (view): view is Extract<ChatSessionView, { status: "ready" }> =>
            isReady(view) &&
            view.messages[1]?.message.type === "assistant" &&
            view.messages[1].message.content.length === 1,
        );
        expect(Option.map(streamed, (view) => ids(view.messages))).toEqual(
          Option.some(["msg_3", "msg_4"]),
        );

        const loading = yield* Effect.forkScoped(
          harness.atoms
            .loadEarlier(harness.registry, { chatId: CHAT_ID })
            .pipe(Effect.provide(harness.fake.layer)),
        );
        const history = yield* harness.fake.next;
        expect(history).toMatchObject({ tag: "chats.getHistory", payload: { before: "msg_3" } });
        history.succeed({
          messages: [userMessage("msg_1", "a"), userMessage("msg_2", "b")],
          hasEarlier: false,
        });
        yield* Fiber.join(loading);
        const paged = yield* harness.viewWhere(
          (view): view is Extract<ChatSessionView, { status: "ready" }> =>
            isReady(view) && view.messages.length === 4,
        );
        expect(
          Option.map(paged, (view) => ({ ids: ids(view.messages), hasEarlier: view.hasEarlier })),
        ).toEqual(Option.some({ ids: ["msg_1", "msg_2", "msg_3", "msg_4"], hasEarlier: false }));
      }),
    ),
  );
});
