import { Debouncer } from "@tanstack/react-pacer";
import type { StateStorage } from "zustand/middleware";

/** localStorage, or an in-memory stand-in where there is none, as in tests without a window. */
export function browserStorage() {
  if (typeof localStorage !== "undefined") return localStorage;
  const store = new Map<string, string>();
  return {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => {
      store.set(name, value);
    },
    removeItem: (name: string) => {
      store.delete(name);
    },
  };
}

/** Keep the latest value and serialize it when the debounce fires or `flush` runs. */
export function createDeferredStorage<TValue>(
  baseStorage: StateStorage,
  serialize: (value: TValue) => string,
  debounceMs = 300,
) {
  const debouncedSetItem = new Debouncer(
    (name: string, value: TValue) => {
      baseStorage.setItem(name, serialize(value));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name: string) => baseStorage.getItem(name),
    setItem: (name: string, value: TValue) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name: string) => {
      debouncedSetItem.cancel();
      // cancel() leaves the captured value in Pacer's lastArgs.
      debouncedSetItem.reset();
      baseStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
