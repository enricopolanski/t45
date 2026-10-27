import { NotFound } from "@t45/contracts/resources/errors";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import { installBrowserEvents, makeFakeApi } from "../../test/fakeApi";
import { reachableAtom } from "../rpc/api";
import { appAtomRegistry } from "./atomRegistry";
import { CHAT_ID, CHAT_SUMMARY, userMessage } from "./chats.testkit";
import { apiQuery, apiWatch } from "./rpc";

afterEach(() => {
  vi.unstubAllGlobals();
  appAtomRegistry.set(reachableAtom, true);
});

const MESSAGE = userMessage("msg_1", "whole");
const MESSAGE_INPUT = {
  chatId: CHAT_ID,
  sessionId: MESSAGE.sessionId,
  messageId: MESSAGE.message.id,
};

const mounted = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) =>
  Effect.acquireRelease(
    Effect.sync(() => registry.mount(atom)),
    (unmount) => Effect.sync(unmount),
  );

const messageQuery = Effect.gen(function* () {
  const fake = yield* makeFakeApi;
  const query = apiQuery("chats.getMessage", fake.atomRuntime)(MESSAGE_INPUT);
  yield* mounted(appAtomRegistry, query);
  const settled = AtomRegistry.getResult(appAtomRegistry, query, { suspendOnWaiting: true });
  return { fake, query, settled };
});

describe("apiQuery", () => {
  it.effect("runs a query that failed to reach the server again once the server answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, query, settled } = yield* messageQuery;
        (yield* fake.next).drop();
        expect(yield* Effect.flip(settled)).toBeInstanceOf(RpcClientError.RpcClientError);
        expect(appAtomRegistry.get(reachableAtom)).toBe(false);

        appAtomRegistry.set(reachableAtom, true);
        const retry = yield* fake.next;
        expect(retry).toMatchObject({ tag: "chats.getMessage", payload: { messageId: "msg_1" } });
        retry.succeed(MESSAGE);
        expect(
          yield* AtomRegistry.getResult(appAtomRegistry, query, { suspendOnWaiting: true }),
        ).toEqual(MESSAGE);
      }),
    ),
  );

  it.effect("keeps a refusal when the server is reachable again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, query, settled } = yield* messageQuery;
        (yield* fake.next).fail(new NotFound());
        expect(yield* Effect.flip(settled)).toBeInstanceOf(NotFound);

        appAtomRegistry.set(reachableAtom, false);
        appAtomRegistry.set(reachableAtom, true);
        const result = appAtomRegistry.get(query);
        expect(result.waiting).toBe(false);
        expect(AsyncResult.isFailure(result) && Cause.squash(result.cause)).toBeInstanceOf(
          NotFound,
        );
      }),
    ),
  );
});

describe("apiWatch", () => {
  it.effect("folds a restarted subscription's snapshot into what its transform holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = installBrowserEvents();
        const fake = yield* makeFakeApi;
        const sizes = apiWatch("chats.watchList", {
          runtime: fake.atomRuntime,
          transform: (lists) =>
            lists.pipe(
              Stream.scan(
                (): ReadonlyArray<number> => [],
                (seen, list) => [...seen, list.chats.length],
              ),
            ),
        })(undefined);
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() => AtomRegistry.make()),
          (registry) => Effect.sync(() => registry.dispose()),
        );
        yield* mounted(registry, sizes);
        const holds = (expected: ReadonlyArray<number>) =>
          AtomRegistry.toStream(registry, sizes).pipe(
            Stream.filter(
              (result) =>
                AsyncResult.isSuccess(result) &&
                JSON.stringify(result.value) === JSON.stringify(expected),
            ),
            Stream.runHead,
          );

        (yield* fake.next).items([{ chats: [] }]);
        yield* holds([0]);
        events.showTab();
        (yield* fake.next).items([{ chats: [CHAT_SUMMARY] }]);
        yield* holds([0, 1]);
      }),
    ),
  );
});
