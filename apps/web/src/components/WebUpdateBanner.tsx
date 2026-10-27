import { useEffect } from "react";

import { BUILD_SHA } from "../lib/buildSha";
import { useSessionState } from "../state/session";
import { Button } from "./ui/button";

const POLL_MS = 60_000;

export function WebUpdateBanner() {
  const { data, refresh } = useSessionState();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const serverVersion = data?.deployVersion ?? BUILD_SHA;
  if (BUILD_SHA === serverVersion) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur-sm"
      role="status"
    >
      <span className="text-muted-foreground">A new version of the application is available.</span>
      <Button size="xs" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
