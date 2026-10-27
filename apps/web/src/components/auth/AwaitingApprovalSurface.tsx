import { useEffect } from "react";

import { useSessionState } from "../../state/session";
import { StandalonePage, StandalonePageHeader } from "../StandalonePage";
import { UseAnotherAccountButton } from "./UseAnotherAccountButton";

const POLL_INTERVAL_MS = 5_000;

/**
 * The zero-access screen for a registration that is waiting for approval. Its
 * user is not active yet, so the app shell never mounts; the poll reloads the
 * page once the session's state stops being pending.
 */
export function AwaitingApprovalSurface() {
  const { data, refresh } = useSessionState();

  useEffect(() => {
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!data) return;
    // Approval keeps this session, so the reload admits the member; a decline ends it.
    if (!data.isAuthenticated || data.state !== "pending") {
      window.location.reload();
    }
  }, [data]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Awaiting approval"
        description="Your registration was received. An admin has to approve you before you can open the organization."
      />
      <div className="mt-6 flex flex-col items-center gap-4">
        <p className="text-sm text-muted-foreground">
          This page checks again automatically. You can leave it open.
        </p>
        <UseAnotherAccountButton />
      </div>
    </StandalonePage>
  );
}
