import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

// Read again on each minute boundary while anything shows it.
const now = Atom.make((get) => {
  const timer = setTimeout(() => get.refreshSelf(), 60_000 - (Date.now() % 60_000));
  get.addFinalizer(() => clearTimeout(timer));
  return Date.now();
});

/** The time, moving on each minute: pass it to relative times so they follow the clock. */
export const useNowMinute = () => useAtomValue(now);
