// @effect-diagnostics globalTimers:off - Display timing for React hooks, outside an Effect runtime.
import { useEffect, useState } from "react";

/**
 * A state must last this long before it shows, and once shown it stays at
 * least this long, so it cannot flash.
 */
export const FLICKER_GUARD_MS = 400;

/**
 * Turns a state that comes and goes into whether to show it, reporting the reset key it is shown
 * for, or null once hidden. `useFlickerFree` wraps this for React.
 */
export function createFlickerFree(onChange: (shownFor: string | null) => void) {
  let resetKey = "";
  let active = false;
  let shown = false;
  // While hidden, this is the show delay. While shown, the minimum visible time.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    shown = false;
    onChange(null);
  };
  const show = () => {
    shown = true;
    onChange(resetKey);
    timer = setTimeout(() => {
      timer = undefined;
      if (!active) hide();
    }, FLICKER_GUARD_MS);
  };

  return {
    /** Reports the real state. A new `resetKey` hides it at once. */
    update: (nextActive: boolean, nextResetKey: string) => {
      if (nextResetKey !== resetKey) {
        resetKey = nextResetKey;
        clearTimer();
        if (shown) hide();
      }
      active = nextActive;

      if (shown) {
        if (!active && timer === undefined) hide();
      } else if (!active) {
        clearTimer();
      } else if (timer === undefined) {
        timer = setTimeout(show, FLICKER_GUARD_MS);
      }
    },
    /** Cancels pending timers. A later `update` starts again from the real state. */
    dispose: clearTimer,
  };
}

/**
 * Whether `active` has lasted `FLICKER_GUARD_MS`, then held at least as long. A new `resetKey`
 * (for example another chat) hides it at once.
 */
export function useFlickerFree(active: boolean, resetKey: string): boolean {
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [flickerFree] = useState(() => createFlickerFree(setShownFor));
  useEffect(() => () => flickerFree.dispose(), [flickerFree]);
  useEffect(() => {
    flickerFree.update(active, resetKey);
  }, [flickerFree, active, resetKey]);
  // The reset reaches state one render late; never show for the old key meanwhile.
  return shownFor === resetKey;
}
