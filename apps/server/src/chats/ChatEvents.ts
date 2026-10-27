/**
 * What changed in which chat, as it happens, for the streams members have open and the chats'
 * followers: a chat's row, its sessions, messages, inputs and questions, the text an agent is
 * streaming, an input or stop request committed for it, and its deletion.
 *
 * Each stream holds only the changes it asked for, and at most `BACKLOG` it hasn't sent: a client
 * that stops reading keeps its stream open, and its request, for as long as its connection lasts.
 * Past that, what the stream holds becomes one `missed`, and it reads everything again.
 */
import type { ChatId } from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export type ChatChange = {
  readonly chatId: ChatId;
} & (
  | { readonly kind: "chat" }
  | { readonly kind: "sessions" }
  | {
      readonly kind: "messages";
      readonly sessionId: string;
      readonly messageIds: ReadonlyArray<string>;
    }
  | {
      readonly kind: "delta";
      readonly sessionId: string;
      readonly messageId: string;
      readonly ordinal: number;
      readonly part: "text" | "reasoning";
      readonly delta: string;
    }
  | { readonly kind: "inputs" }
  | { readonly kind: "questions" }
  | { readonly kind: "posted" }
  | { readonly kind: "deleted" }
);

/** The stream fell too far behind and dropped what it held: read everything again. */
export interface Missed {
  readonly kind: "missed";
}

const MISSED: Missed = { kind: "missed" };

/** Changes one stream holds before it drops them for `missed`. */
const BACKLOG = 1_000;

export class ChatEvents extends Context.Service<
  ChatEvents,
  {
    readonly publish: (change: ChatChange) => Effect.Effect<void>;
    readonly subscribe: (
      accepts: (change: ChatChange) => boolean,
    ) => Effect.Effect<Stream.Stream<ChatChange | Missed>, never, Scope.Scope>;
  }
>()("t45/chats/ChatEvents") {}

interface Subscriber {
  readonly accepts: (change: ChatChange) => boolean;
  readonly queue: Queue.Queue<ChatChange | Missed>;
}

export const layer = Layer.sync(ChatEvents, () => {
  const subscribers = new Set<Subscriber>();
  return ChatEvents.of({
    publish: (change) =>
      Effect.sync(() => {
        for (const subscriber of subscribers) {
          if (!subscriber.accepts(change) || Queue.offerUnsafe(subscriber.queue, change)) continue;
          while (Queue.sizeUnsafe(subscriber.queue) > 0) Queue.takeUnsafe(subscriber.queue);
          Queue.offerUnsafe(subscriber.queue, MISSED);
        }
      }),
    subscribe: (accepts) =>
      Effect.acquireRelease(
        Queue.dropping<ChatChange | Missed>(BACKLOG).pipe(
          Effect.flatMap((queue) =>
            Effect.sync(() => {
              const subscriber: Subscriber = { accepts, queue };
              subscribers.add(subscriber);
              return subscriber;
            }),
          ),
        ),
        (subscriber) =>
          Effect.sync(() => subscribers.delete(subscriber)).pipe(
            Effect.andThen(Queue.shutdown(subscriber.queue)),
          ),
      ).pipe(Effect.map((subscriber) => Stream.fromQueue(subscriber.queue))),
  });
});
