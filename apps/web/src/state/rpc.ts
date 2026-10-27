import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  type ApiClient,
  type ApiFailure,
  type ApiInput,
  type ApiItem,
  type StreamTag,
  type UnaryTag,
  atomRuntime,
  call,
  reachableAtom,
  watch,
} from "../rpc/api";
import { describeFailure, isRpcClientError } from "../lib/failures";

/** The runtime query and watch atoms run on; tests pass one over their own transport. */
type ApiAtomRuntime = Atom.AtomRuntime<ApiClient>;

/**
 * One call per input. One that failed to reach the server runs again once a call or a watch gets
 * an answer, or when the tab is shown again. A result is fresh for 30 s, and the atom lives
 * 5 minutes past its last reader.
 */
export function apiQuery<T extends UnaryTag>(tag: T, runtime: ApiAtomRuntime = atomRuntime) {
  return Atom.family((input: ApiInput<T>) =>
    runtime
      .atom((get) =>
        call(tag, input).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (isRpcClientError(error)) {
                get(reachableAtom);
                get(Atom.windowFocusSignal);
              }
            }),
          ),
        ),
      )
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`${tag}:${JSON.stringify(input)}`),
      ),
  );
}

interface WatchOptions {
  readonly runtime?: ApiAtomRuntime;
  readonly idleTtlMs?: number;
}

type WatchAtom<A, T extends StreamTag> = Atom.Atom<
  AsyncResult.AsyncResult<A, ApiFailure<T> | Cause.NoSuchElementError>
>;

/**
 * One watch per input, folded by `transform` across its restarts. It closes `idleTtlMs`
 * (5 minutes unless set) after its last reader leaves.
 */
export function apiWatch<T extends StreamTag, B>(
  tag: T,
  options: WatchOptions & {
    readonly transform: (
      stream: Stream.Stream<ApiItem<T>, ApiFailure<T>, ApiClient>,
    ) => Stream.Stream<B, ApiFailure<T>, ApiClient>;
  },
): (input: ApiInput<T>) => WatchAtom<B, T>;
export function apiWatch<T extends StreamTag>(
  tag: T,
  options?: WatchOptions,
): (input: ApiInput<T>) => WatchAtom<ApiItem<T>, T>;
export function apiWatch<T extends StreamTag>(
  tag: T,
  options: WatchOptions & {
    readonly transform?: (
      stream: Stream.Stream<ApiItem<T>, ApiFailure<T>, ApiClient>,
    ) => Stream.Stream<unknown, ApiFailure<T>, ApiClient>;
  } = {},
): (input: ApiInput<T>) => WatchAtom<unknown, T> {
  const runtime = options.runtime ?? atomRuntime;
  const transform = options.transform ?? identity;
  return Atom.family((input: ApiInput<T>) =>
    runtime
      .atom(transform(watch(tag, input)))
      .pipe(
        Atom.setIdleTTL(options.idleTtlMs ?? 5 * 60_000),
        Atom.withLabel(`${tag}:${JSON.stringify(input)}`),
      ),
  );
}

const NO_QUERY_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("api-query:none"),
);

export interface QueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/** A query's or a watch's latest value; null reads nothing. */
export function useApiQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): QueryView<A> {
  const selected = atom ?? NO_QUERY_ATOM;
  const result = useAtomValue(selected);
  const refresh = useAtomRefresh(selected);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? describeFailure(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh,
  };
}
