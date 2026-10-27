import { useAtomRefresh, useAtomSuspense, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { describeFailure } from "../lib/failures";
import { appAtomRegistry } from "./atomRegistry";

export class LoadFailed extends Error {
  constructor(
    message: string,
    readonly retry: () => void,
  ) {
    super(message);
  }
}

export function useLoaded<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): A {
  const refresh = useAtomRefresh(atom);
  const loaded = Option.isSome(AsyncResult.value(useAtomValue(atom)));
  const result = useAtomSuspense(atom, { includeFailure: true, suspendOnWaiting: !loaded });
  if (result._tag === "Success") return result.value;
  const previous = AsyncResult.value(result);
  if (Option.isSome(previous)) return previous.value;
  throw new LoadFailed(describeFailure(result.cause), refresh);
}

export const toastFailure = (title: string, failure: unknown) => {
  toastManager.add({ type: "error", title, description: describeFailure(failure) });
};

export const mutate = (request: Promise<unknown>, atom: Atom.Atom<unknown>, failure: string) =>
  request.then(
    () => appAtomRegistry.refresh(atom),
    (cause: unknown) => toastFailure(failure, cause),
  );
