import { SidebarContent } from "../ui/sidebar";
import { AppNavGroup, NavLinks } from "../sidebar/AppNav";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SETTINGS_GROUPS } from "./settingsSections";

export function SettingsSidebarNav() {
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_GROUPS.map((group) => (
          <AppNavGroup key={group.label} label={group.label}>
            <NavLinks links={group.links} />
          </AppNavGroup>
        ))}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
