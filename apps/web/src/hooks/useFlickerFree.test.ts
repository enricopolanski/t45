import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createFlickerFree, FLICKER_GUARD_MS } from "./useFlickerFree";

function track() {
  const changes: Array<string | null> = [];
  const flickerFree = createFlickerFree((shownFor) => changes.push(shownFor));
  return { changes, flickerFree };
}

describe("createFlickerFree", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows a state that ends before the guard time", () => {
    const { changes, flickerFree } = track();
    flickerFree.update(true, "a");
    vi.advanceTimersByTime(FLICKER_GUARD_MS - 1);
    flickerFree.update(false, "a");
    vi.runAllTimers();

    expect(changes).toEqual([]);
  });

  it("holds a shown state for the guard time, then hides it at once", () => {
    const { changes, flickerFree } = track();
    flickerFree.update(true, "a");
    vi.advanceTimersByTime(FLICKER_GUARD_MS);
    expect(changes).toEqual(["a"]);

    flickerFree.update(false, "a");
    vi.advanceTimersByTime(FLICKER_GUARD_MS - 1);
    expect(changes.at(-1)).toBe("a");
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toBeNull();

    flickerFree.update(true, "a");
    vi.advanceTimersByTime(FLICKER_GUARD_MS * 2);
    flickerFree.update(false, "a");
    expect(changes.at(-1)).toBeNull();
  });

  it("hides the shown state at once when the reset key changes", () => {
    const { changes, flickerFree } = track();
    flickerFree.update(true, "a");
    vi.advanceTimersByTime(FLICKER_GUARD_MS);
    flickerFree.update(true, "b");
    expect(changes.at(-1)).toBeNull();

    vi.advanceTimersByTime(FLICKER_GUARD_MS);
    expect(changes.at(-1)).toBe("b");
  });
});
