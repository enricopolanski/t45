import type { SessionMessage } from "@opencode/client/effect";
import type { Chat, ChatId } from "@t45/contracts/models/Chat";
import type * as Effect from "effect/Effect";

export interface ChatHooks {
  /** Whether somebody can answer the chat's questions; its agent can't ask any otherwise. */
  readonly questions: (chatId: ChatId) => Effect.Effect<boolean>;
  readonly saved: (
    chatId: ChatId,
    messages: ReadonlyArray<SessionMessage.Info>,
    read: (path: string) => Effect.Effect<Uint8Array | null>,
  ) => Effect.Effect<void>;
  /** The chat's execution ended with `status`; runs in the transaction that records it. */
  readonly ended: (chatId: ChatId, status: Chat["status"]) => Effect.Effect<void>;
}
