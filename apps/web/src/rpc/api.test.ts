import { AccessDenied } from "@t45/contracts/resources/errors";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { installBrowserEvents, makeFakeApi } from "../../test/fakeApi";
import { CHAT_SUMMARY } from "../state/chats.testkit";
import { appAtomRegistry } from "../state/atomRegistry";
import { call, onAccessDenied, reachableAtom, watch } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  onAccessDenied(() => {});
  appAtomRegistry.set(reachableAtom, true);
});

const EMPTY = { chats: [] };
const ONE = { chats: [CHAT_SUMMARY] };

const watchChatList = Effect.gen(function* () {
  const fake = yield* makeFakeApi;
  const events = installBrowserEvents();
  const client = yield* Layer.build(fake.layer);
  const items = yield* watch("chats.watchList", undefined).pipe(
    Stream.provideContext(client),
    Stream.toQueue({ capacity: "unbounded" }),
  );
  return { fake, events, client, items };
});

describe("watch", () => {
  it.effect("subscribes again after a transport failure, and reachability follows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, items } = yield* watchChatList;
        const reachability = yield* Queue.unbounded<boolean>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            appAtomRegistry.subscribe(
              reachableAtom,
              (isReachable) => {
                Queue.offerUnsafe(reachability, isReachable);
              },
              { immediate: true },
            ),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        expect(yield* Queue.take(reachability)).toBe(true);

        const first = yield* fake.next;
        expect(first.tag).toBe("chats.watchList");
        first.items([EMPTY]);
        expect(yield* Queue.take(items)).toEqual(EMPTY);

        first.drop();
        expect(yield* Queue.take(reachability)).toBe(false);
        yield* TestClock.adjust("1 second");
        const second = yield* fake.next;
        expect(second.tag).toBe("chats.watchList");
        second.items([ONE]);
        expect(yield* Queue.take(items)).toEqual(ONE);
        expect(yield* Queue.take(reachability)).toBe(true);
        expect(yield* Queue.size(reachability)).toBe(0);
      }),
    ),
  );

  it.effect("subscribes again when the tab returns to view, closing the held call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, events, items } = yield* watchChatList;
        const first = yield* fake.next;
        first.items([EMPTY]);
        expect(yield* Queue.take(items)).toEqual(EMPTY);

        events.showTab();
        const second = yield* fake.next;
        yield* first.closed;
        second.items([ONE]);
        expect(yield* Queue.take(items)).toEqual(ONE);
      }),
    ),
  );

  it.effect("ends on a defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, items } = yield* watchChatList;
        const first = yield* fake.next;
        first.die("The database is gone.");

        const failure = yield* Effect.flip(Queue.take(items));
        expect(failure).toBeInstanceOf(Cause.UnknownError);
        expect(failure).toMatchObject({ message: "Something went wrong on the server." });
      }),
    ),
  );

  it.effect("reports an AccessDenied once, from a watch and from a call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, client, items } = yield* watchChatList;
        let denials = 0;
        onAccessDenied(() => {
          denials += 1;
        });
        const signedOut = new AccessDenied({ message: "This session was signed out." });

        (yield* fake.next).fail(signedOut);
        expect(yield* Effect.flip(Queue.take(items))).toEqual(signedOut);
        expect(denials).toBe(1);

        const answer = yield* Effect.forkScoped(
          call("organization.get", undefined).pipe(Effect.provideContext(client), Effect.flip),
        );
        (yield* fake.next).fail(signedOut);
        expect(yield* Fiber.join(answer)).toEqual(signedOut);
        expect(denials).toBe(2);
      }),
    ),
  );
});
