import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";

import { cn } from "../lib/utils";
import { useIsAdmin } from "../state/session";
import { AppNavSidebar } from "./sidebar/AppNav";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { useTrackMainAppLocation } from "./sidebar/mainAppLocation";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function SidebarControl() {
  const { isMobile, openMobile } = useSidebar();

  if (!isMobile) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--sidebar-toggle-left)] top-[var(--sidebar-toggle-top)] z-50 ml-px flex h-[var(--page-header-height)] items-center",
        openMobile && "invisible",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">Toggle main sidebar</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const isAdmin = useIsAdmin();
  useTrackMainAppLocation();
  const showSettingsSidebar =
    /^\/settings(\/|$)/u.test(pathname) &&
    (isAdmin || !/^\/settings\/(workflows|workflow-blueprints)(\/|$)/u.test(pathname));

  return (
    <SidebarProvider>
      <Sidebar role="navigation" aria-label={showSettingsSidebar ? "Settings" : "Main"}>
        {showSettingsSidebar ? (
          <>
            <SidebarChromeHeader />
            <SettingsSidebarNav />
          </>
        ) : (
          <AppNavSidebar />
        )}
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
