import { useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";

/** Page-local data: load on entry, reload after a successful edit. Keep callbacks stable. */
export function useWorkflowData<A>(
  load: (current: A | null) => Promise<A>,
  onLoad?: (loaded: A) => void,
) {
  const [detail, setDetail] = useState<A | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void load(null).then(
      (loaded) => {
        if (!current) return;
        setDetail(loaded);
        onLoad?.(loaded);
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [load, onLoad]);

  const run = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
      const loaded = await load(detail);
      setDetail(loaded);
      onLoad?.(loaded);
      return true;
    } catch (cause) {
      setError(describeFailure(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { detail, busy, error, run };
}
