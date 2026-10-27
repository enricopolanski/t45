import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { checkSignedOut, fetchSessionState } from "../http/auth";
import { reachableAtom } from "../rpc/api";
import { useApiQuery } from "./rpc";

const recoveredSignal = Atom.readable((get) => {
  let recoveries = 0;
  let wasReachable = get.once(reachableAtom);
  get.subscribe(reachableAtom, (isReachable) => {
    if (isReachable && !wasReachable) get.setSelf(++recoveries);
    wasReachable = isReachable;
  });
  return recoveries;
});

const sessionStateAtom = Atom.make(
  Effect.tryPromise(fetchSessionState).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        if (!session.isAuthenticated) void checkSignedOut();
      }),
    ),
  ),
).pipe(
  Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
  Atom.makeRefreshOnSignal(recoveredSignal),
  Atom.refreshOnWindowFocus,
  Atom.setIdleTTL(5 * 60_000),
  Atom.withLabel("server:session"),
);

export const useSessionState = () => useApiQuery(sessionStateAtom);

/** The signed-in member's server session: who they are, their role and their state. */
export const useSession = () => {
  const { data } = useSessionState();
  return data?.isAuthenticated ? data : null;
};

/** Organization admins: the only people who know Settings exists. */
export const useIsAdmin = () => useSession()?.role === "admin";
