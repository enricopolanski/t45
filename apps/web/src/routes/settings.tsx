import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { requireAdmin } from "../http/auth";
import { SETTINGS_GROUPS } from "../components/settings/settingsSections";
import { PageBreadcrumb } from "../components/PageBreadcrumb";
import { SidebarInset } from "../components/ui/sidebar";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { PageHeader } from "../components/PageHeader";
import { useEscapeToGoBack } from "../hooks/useEscapeToGoBack";

function SettingsContentLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const title =
    SETTINGS_GROUPS.flatMap((group) => group.links).find((section) => section.to === pathname)
      ?.label ?? "Settings";
  const navigateToMainApp = useNavigateToMainApp();
  useEscapeToGoBack(navigateToMainApp);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <PageHeader>
          <PageBreadcrumb title={title} />
        </PageHeader>

        <div className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ location }) => {
    await requireAdmin();
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/automations", replace: true });
    }
  },
  component: SettingsContentLayout,
});
