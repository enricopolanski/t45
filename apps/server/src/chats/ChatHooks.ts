import type { SessionMessage } from "@opencode/client/effect";
import type { Chat, ChatId } from "@t45/contracts/models/Chat";
import type * as Effect from "effect/Effect";

export interface ChatHooks {
  readonly policy: (chatId: ChatId) => Effect.Effect<{
    readonly questions: boolean;
    readonly recover: boolean;
    /** Keep the idle VM available between turns; finished background runs release it. */
    readonly keepAlive: boolean;
  }>;
  readonly instructions?: (chatId: ChatId) => Effect.Effect<string>;
  readonly saved: (
    chatId: ChatId,
    messages: ReadonlyArray<SessionMessage.Info>,
    read: (path: string) => Effect.Effect<Uint8Array | null>,
    reply?: (requestId: string, text: string) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly ended: (chatId: ChatId, status: Chat["status"]) => Effect.Effect<void>;
}
