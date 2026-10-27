import type { WorkflowInstanceView } from "@t45/contracts/resources/Workflows";
import { useEffect, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";

/** A workflow for an editing page: loads it, and runs the page's requests against it. */
export function useWorkflowDetail(workflowId: string) {
  const [detail, setDetail] = useState<WorkflowInstanceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api("workflows.getInstance", { idOrSlug: workflowId }).then(
      (loaded) => {
        if (current) setDetail(loaded);
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [workflowId]);

  const run = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
      const loaded = await api("workflows.getInstance", {
        idOrSlug: detail?.workflow.id ?? workflowId,
      });
      setDetail(loaded);
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
