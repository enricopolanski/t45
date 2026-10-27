import { useEffect, useState } from "react";

export function useDelayedTrue(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => setElapsed(true), ms);
    return () => {
      window.clearTimeout(timeout);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}
