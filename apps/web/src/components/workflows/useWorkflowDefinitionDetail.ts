import type { WorkflowDefinitionView } from "@t45/contracts/resources/Workflows";
import { useEffect, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";

export function useWorkflowDefinitionDetail(
  definitionId: string,
  onLoad: (detail: WorkflowDefinitionView) => void,
) {
  const [detail, setDetail] = useState<WorkflowDefinitionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api("workflows.getDefinition", { definitionId }).then(
      (loaded) => {
        if (!current) return;
        setDetail(loaded);
        onLoad(loaded);
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [definitionId, onLoad]);

  const run = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
      const loaded = await api("workflows.getDefinition", { definitionId });
      setDetail(loaded);
      onLoad(loaded);
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
