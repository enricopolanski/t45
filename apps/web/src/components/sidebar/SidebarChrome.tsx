import { ArrowLeftIcon, SettingsIcon } from "lucide-react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { useOrganizationIfLoaded } from "../../state/organization";
import { useIsAdmin } from "../../state/session";
import { OrganizationAvatar } from "../people/UserAvatar";
import { isSettingsPage, useNavigateToMainApp } from "./mainAppLocation";

/** The organization's logo, or T45 while it has none, linking home. */
export function SidebarChromeHeader() {
  const organization = useOrganizationIfLoaded();
  return (
    // The page headers' spacing, and at least their height: a tall logo makes it taller.
    <div className="flex min-h-[var(--page-header-height)] shrink-0 flex-row items-center gap-2 px-3 md:pl-0">
      <SidebarTrigger className="md:hidden" />
      {/* The padding keeps the brand's focus ring inside the clip. */}
      <div className="flex min-h-8 min-w-0 flex-1 items-center overflow-hidden py-0.5">
        <Link
          aria-label="Go to Home"
          className="ml-[var(--sidebar-toggle-left)] hidden min-h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2 md:flex"
          to="/my-work"
        >
          {organization?.avatar.kind === "image" ? (
            <span className="flex px-1 py-2">
              <OrganizationAvatar
                name={organization.name ?? ""}
                avatar={organization.avatar}
                className="w-32"
              />
            </span>
          ) : (
            // Center the visible capitals, without the font's ascender/descender space.
            <span className="truncate text-sm font-medium tracking-tight [text-box:trim-both_cap_alphabetic] px-2.5">
              T45
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}

/** Settings for admins; on a Settings page, Back to the page it was opened from. */
export function SidebarChromeFooter() {
  const canManage = useIsAdmin();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { setOpenMobile } = useSidebar();
  const isOnSettingsPage = useLocation({
    select: (location) => isSettingsPage(location.pathname),
  });

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          {isOnSettingsPage ? (
            <SidebarMenuButton
              onClick={() => {
                setOpenMobile(false);
                void navigateToMainApp();
              }}
            >
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          ) : canManage ? (
            <SidebarMenuButton
              onClick={() => {
                setOpenMobile(false);
                void navigate({ to: "/settings" });
              }}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          ) : null}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
