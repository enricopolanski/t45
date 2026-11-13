import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

// Read again on each second boundary while anything shows it.
const now = Atom.make((get) => {
  const timer = setTimeout(() => get.refreshSelf(), 1_000 - (Date.now() % 1_000));
  get.addFinalizer(() => clearTimeout(timer));
  return Date.now();
});

/** The time, moving on each second: pass it to relative times that count seconds. */
export const useNowSecond = () => useAtomValue(now);
