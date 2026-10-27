import { useAtomValue } from "@effect/atom-react";
import { type Refusal, Refused } from "@t45/contracts/models/Chat";
import type {
  ChatEvent,
  ChatHistory,
  ChatMessage,
  ChatSession,
  ChatSummary,
  PendingInput,
  Question,
} from "@t45/contracts/resources/Chats";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { type ApiClient, type ApiInput, atomRuntime, call, runtime } from "../rpc/api";
import { describeFailure } from "../lib/failures";
import { appAtomRegistry } from "./atomRegistry";
import { apiQuery, apiWatch } from "./rpc";

/** A message exactly as OpenCode keeps it. */
export type NativeMessage = ChatMessage["message"];
export type NativeMessageId = NativeMessage["id"];
export type NativeAssistantMessage = Extract<NativeMessage, { type: "assistant" }>;
export type NativeAssistantPart = NativeAssistantMessage["content"][number];
export type NativeToolPart = Extract<NativeAssistantPart, { type: "tool" }>;

/** One session of a chat as `chats.watch` last described it. */
export interface ChatSnapshot {
  readonly chat: ChatSummary;
  readonly sessions: ReadonlyArray<ChatSession>;
  /** Oldest first. */
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly hasEarlier: boolean;
  readonly inputs: ReadonlyArray<PendingInput>;
  readonly questions: ReadonlyArray<Question>;
}

type Delta = Extract<ChatEvent, { _tag: "delta" }>;
type StreamedPart = Extract<NativeAssistantPart, { type: Delta["kind"] }>;
type Unseen = ReadonlyMap<NativeMessageId, ReadonlyArray<StreamedPart>>;

/**
 * What the stream folded so far: nothing until its first snapshot. `unseen` holds what streamed
 * for live messages the browser has no copy of yet, a few at most, until their first copy.
 */
export type ChatStreamState =
  | { readonly loaded: false }
  | ({ readonly loaded: true; readonly unseen: Unseen } & ChatSnapshot);

export const CHAT_STREAM_NOT_LOADED: ChatStreamState = { loaded: false };

/** How many live messages the browser keeps streamed text for before their first copy. */
const UNSEEN_LIMIT = 4;

const messageId = (message: ChatMessage) => message.message.id;

const isStreamedPart = (part: NativeAssistantPart): part is StreamedPart =>
  part.type === "text" || part.type === "reasoning";

/**
 * `content` with the delta added to its `ordinal`-th part of the delta's kind, as OpenCode numbers
 * text and reasoning parts each on their own; a new part when it is the next of its kind. Null
 * when the part is further on: the message's next copy brings it.
 */
function withDelta<Part extends NativeAssistantPart>(
  content: ReadonlyArray<Part>,
  delta: Delta,
): ReadonlyArray<Part | StreamedPart> | null {
  let seen = 0;
  for (const [at, part] of content.entries()) {
    if (part.type !== delta.kind || !isStreamedPart(part)) continue;
    if (seen++ < delta.ordinal) continue;
    return content.with(at, { ...part, text: part.text + delta.delta });
  }
  return seen === delta.ordinal ? [...content, { type: delta.kind, text: delta.delta }] : null;
}

/**
 * A new copy of a live assistant message, keeping the text the browser streamed past it: OpenCode
 * writes a part's text into its copy only once the part ends, so a part with text is final unless
 * the read cut it. Parts match by kind and order; one streamed that the copy doesn't have yet stays
 * at the end. Any other copy wins as it is.
 */
function keepStreamed(
  streamed: ReadonlyArray<NativeAssistantPart>,
  incoming: ChatMessage,
): ChatMessage {
  if (incoming.state !== "live" || incoming.message.type !== "assistant") return incoming;
  const local = {
    text: streamed.filter((part) => part.type === "text"),
    reasoning: streamed.filter((part) => part.type === "reasoning"),
  };
  const seen = { text: 0, reasoning: 0 };
  let kept = false;
  const content = incoming.message.content.map((part) => {
    if (!isStreamedPart(part)) return part;
    const mine = local[part.type][seen[part.type]++];
    if (mine === undefined || mine.text.length <= part.text.length) return part;
    if (part.text !== "" && !(incoming.isTruncated && mine.text.startsWith(part.text))) return part;
    kept = true;
    return { ...part, text: mine.text };
  });
  const ahead = [...local.text.slice(seen.text), ...local.reasoning.slice(seen.reasoning)];
  if (!kept && ahead.length === 0) return incoming;
  return { ...incoming, message: { ...incoming.message, content: [...content, ...ahead] } };
}

/** What the browser streamed of a message: its own copy while live, or what waits unseen. */
function streamedOf(
  held: ChatMessage | undefined,
  unseen: Unseen,
  id: NativeMessageId,
): ReadonlyArray<NativeAssistantPart> {
  if (held?.state === "live" && held.message.type === "assistant") return held.message.content;
  return unseen.get(id) ?? [];
}

interface Folded {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly unseen: Unseen;
}

/** Replaces each message by id, or adds it at the end, keeping what streamed past a live one. */
function upsertMessages(state: Folded, incoming: ReadonlyArray<ChatMessage>): Folded {
  if (incoming.length === 0) return state;
  const next = [...state.messages];
  const unseen = new Map(state.unseen);
  const indexById = new Map(next.map((message, index) => [messageId(message), index]));
  for (const message of incoming) {
    const id = messageId(message);
    const index = indexById.get(id);
    const merged = keepStreamed(
      streamedOf(index === undefined ? undefined : next[index], unseen, id),
      message,
    );
    unseen.delete(id);
    if (index === undefined) {
      indexById.set(id, next.length);
      next.push(merged);
    } else {
      next[index] = merged;
    }
  }
  return { messages: next, unseen };
}

function applyDelta(state: Folded, delta: Delta): Folded {
  const index = state.messages.findLastIndex((message) => messageId(message) === delta.messageId);
  const current = state.messages[index];
  if (current === undefined) {
    // Its first copy is on its way: the text waits for it.
    const content = withDelta(state.unseen.get(delta.messageId) ?? [], delta);
    if (content === null) return state;
    const unseen = new Map(state.unseen);
    unseen.delete(delta.messageId);
    unseen.set(delta.messageId, content);
    for (const id of unseen.keys()) {
      if (unseen.size <= UNSEEN_LIMIT) break;
      unseen.delete(id);
    }
    return { messages: state.messages, unseen };
  }
  // A finished message waits for its next full copy instead.
  if (current.state !== "live" || current.message.type !== "assistant") return state;
  const content = withDelta(current.message.content, delta);
  if (content === null) return state;
  const next = [...state.messages];
  next[index] = { ...current, message: { ...current.message, content } };
  return { messages: next, unseen: state.unseen };
}

/**
 * Folds one `chats.watch` event into the session's state. A snapshot replaces everything (a
 * resubscription after a restart opens with one); a message replaces the one with its id or
 * joins the end; a delta appends streamed text to a part of a live assistant message. Either
 * keeps the text streamed past a live message's copy.
 */
export function applyChatEvent(state: ChatStreamState, event: ChatEvent): ChatStreamState {
  if (event._tag === "snapshot") {
    const held: Folded = state.loaded ? state : { messages: [], unseen: new Map() };
    const heldById = new Map(held.messages.map((message) => [messageId(message), message]));
    const unseen = new Map(held.unseen);
    for (const message of event.messages) unseen.delete(messageId(message));
    return {
      loaded: true,
      unseen,
      chat: event.chat,
      sessions: event.sessions,
      messages: event.messages.map((message) => {
        const id = messageId(message);
        return keepStreamed(streamedOf(heldById.get(id), held.unseen, id), message);
      }),
      hasEarlier: event.hasEarlier,
      inputs: event.inputs,
      questions: event.questions,
    };
  }
  if (!state.loaded) return state;
  switch (event._tag) {
    case "chat":
      return { ...state, chat: event.chat };
    case "sessions":
      return { ...state, sessions: event.sessions };
    case "messages":
      return { ...state, ...upsertMessages(state, event.messages) };
    case "delta": {
      const next = applyDelta(state, event);
      return next === state ? state : { ...state, ...next };
    }
    case "inputs":
      return { ...state, inputs: event.inputs };
    case "questions":
      return { ...state, questions: event.questions };
  }
}

/** Older pages of a session, loaded through `chats.getHistory` in front of the streamed window. */
export interface ChatEarlierPages {
  /** The streamed window's first message when the first page loaded; the pages end before it. */
  readonly anchor: NativeMessageId | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

export const NO_EARLIER_PAGES: ChatEarlierPages = {
  anchor: null,
  messages: [],
  hasEarlier: false,
  loading: false,
  error: null,
};

function pagesJoinWindow(live: Pick<ChatSnapshot, "messages">, pages: ChatEarlierPages): boolean {
  return (
    pages.anchor !== null &&
    pages.messages.length > 0 &&
    live.messages.some((message) => messageId(message) === pages.anchor)
  );
}

/**
 * The loaded pages in front of the streamed window. They only join it while the window still
 * holds the message they end before: a snapshot that skipped past it leaves a gap, so the pages
 * are dropped and paging starts again from the window.
 */
export function mergeEarlierPages(
  live: Pick<ChatSnapshot, "messages" | "hasEarlier">,
  pages: ChatEarlierPages,
): { readonly messages: ReadonlyArray<ChatMessage>; readonly hasEarlier: boolean } {
  if (!pagesJoinWindow(live, pages)) {
    return { messages: live.messages, hasEarlier: live.hasEarlier };
  }
  const liveIds = new Set(live.messages.map(messageId));
  return {
    messages: [
      ...pages.messages.filter((message) => !liveIds.has(messageId(message))),
      ...live.messages,
    ],
    hasEarlier: pages.hasEarlier,
  };
}

/** A session of a chat and everything loaded for it. */
export type ChatSessionView =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: unknown }
  | ({
      readonly status: "ready";
      readonly loadingEarlier: boolean;
      readonly earlierError: string | null;
    } & ChatSnapshot);

const CHAT_SESSION_LOADING: ChatSessionView = { status: "loading" };

const isChatRefused = Schema.is(Refused);

/** Why T45 refused a chat request, when it was T45 that refused it. */
export function chatErrorReason(error: unknown): Refusal | null {
  return isChatRefused(error) ? error.reason : null;
}

export type ChatSessionKey = ApiInput<"chats.watch">;

/** The chat session `key` names: `{ chatId }` for its root, with `sessionId` for a subagent. */
export function chatSessionKey(
  chatId: ChatSessionKey["chatId"],
  sessionId?: ChatSessionKey["sessionId"] | null,
): ChatSessionKey {
  return sessionId ? { chatId, sessionId } : { chatId };
}

/**
 * How long a chat's stream stays open after its last reader leaves. Nothing outlives it: a return
 * after that folds a fresh stream from its first snapshot, as a reload does.
 */
const CHAT_IDLE_TTL_MS = 2_000;

export function createChatAtoms(runtime: Atom.AtomRuntime<ApiClient> = atomRuntime) {
  const stream = apiWatch("chats.watch", {
    runtime,
    idleTtlMs: CHAT_IDLE_TTL_MS,
    transform: (events) => events.pipe(Stream.scan(() => CHAT_STREAM_NOT_LOADED, applyChatEvent)),
  });
  const earlier = Atom.family((_key: ChatSessionKey) =>
    Atom.make(NO_EARLIER_PAGES).pipe(Atom.setIdleTTL(CHAT_IDLE_TTL_MS)),
  );
  const view = Atom.family((key: ChatSessionKey) =>
    Atom.make((get): ChatSessionView => {
      const result = get(stream(key));
      if (result._tag === "Failure") {
        return { status: "failed", error: Cause.squash(result.cause) };
      }
      if (result._tag === "Initial" || !result.value.loaded) return CHAT_SESSION_LOADING;
      const pages = get(earlier(key));
      const merged = mergeEarlierPages(result.value, pages);
      return {
        ...result.value,
        ...merged,
        status: "ready",
        loadingEarlier: pages.loading,
        earlierError: pages.error,
      };
    }).pipe(Atom.withLabel(`chats:view:${JSON.stringify(key)}`)),
  );

  /** Loads the page before the session's first loaded message; a failure shows in its view. */
  const loadEarlier = Effect.fnUntraced(function* (
    registry: AtomRegistry.AtomRegistry,
    key: ChatSessionKey,
  ) {
    const result = registry.get(stream(key));
    if (!AsyncResult.isSuccess(result) || !result.value.loaded) return;
    const live = result.value;
    const pagesAtom = earlier(key);
    const pages = registry.get(pagesAtom);
    if (pages.loading) return;
    const merged = mergeEarlierPages(live, pages);
    const first = merged.messages[0];
    if (!merged.hasEarlier || first === undefined) return;
    const sessionId = first.sessionId;
    const before = messageId(first);
    registry.set(pagesAtom, { ...pages, loading: true, error: null });
    const page = yield* Effect.exit(
      call("chats.getHistory", { chatId: key.chatId, sessionId, before }),
    );
    const settled = { ...registry.get(pagesAtom), loading: false };
    if (Exit.isFailure(page)) {
      registry.set(pagesAtom, { ...settled, error: describeFailure(page.cause) });
      return;
    }
    // Merge against what is current now: the window may have moved while the page loaded.
    const latestLive = registry.get(stream(key));
    registry.set(
      pagesAtom,
      AsyncResult.isSuccess(latestLive) && latestLive.value.loaded
        ? prependEarlierPage(latestLive.value, settled, before, page.value)
        : settled,
    );
  });

  return {
    /** The session's state: a snapshot and its changes, with loaded earlier pages in front. */
    view,
    loadEarlier,
    reopen: (registry: AtomRegistry.AtomRegistry, key: ChatSessionKey) =>
      registry.refresh(stream(key)),
  };
}

/**
 * Puts a page loaded before `before` in front of the loaded messages, if `before` is still their
 * first message. A page that no longer joins anything is dropped.
 */
export function prependEarlierPage(
  live: Pick<ChatSnapshot, "messages" | "hasEarlier">,
  pages: ChatEarlierPages,
  before: NativeMessageId,
  page: ChatHistory,
): ChatEarlierPages {
  const first = mergeEarlierPages(live, pages).messages[0];
  if (first === undefined || messageId(first) !== before) return pages;
  const joinsPages = pagesJoinWindow(live, pages);
  return {
    ...pages,
    anchor: joinsPages ? pages.anchor : before,
    messages: joinsPages ? [...page.messages, ...pages.messages] : page.messages,
    hasEarlier: page.hasEarlier,
  };
}

const chatAtoms = createChatAtoms();

export const chats = {
  view: chatAtoms.view,
  loadEarlier: (key: ChatSessionKey) =>
    runtime.runPromise(chatAtoms.loadEarlier(appAtomRegistry, key)),
  reopen: (key: ChatSessionKey) => chatAtoms.reopen(appAtomRegistry, key),
  /** One message whole, for tool output and text a read cut short. */
  message: apiQuery("chats.getMessage"),
  /**
   * The Chat page's list: the full list on subscribe and again after changes. The
   * server pushes it to every open subscription, so close it soon after the page goes.
   */
  list: apiWatch("chats.watchList", { idleTtlMs: 15_000 })(undefined),
};

export function useChatSessionView(key: ChatSessionKey): ChatSessionView {
  return useAtomValue(chats.view(key));
}
