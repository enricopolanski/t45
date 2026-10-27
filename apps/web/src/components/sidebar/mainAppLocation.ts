import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

// Settings replaces the sidebar's Settings button with Back; everything else is the main app.
export function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

let mainAppHref: string | null = null;

// Called once by the app shell, around every page. Records the latest main app URL so Back can
// return there no matter how many Settings pages were visited since.
export function useTrackMainAppLocation() {
  const href = useLocation({
    select: (location) => (isSettingsPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
}

// Leaves Settings for the last main app URL, or the chat list when the app was opened directly
// on a Settings page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppHref ?? "/chats" }), [navigate]);
}
