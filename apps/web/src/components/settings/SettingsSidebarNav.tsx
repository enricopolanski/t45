import { SidebarContent, SidebarGroup, SidebarMenu } from "../ui/sidebar";
import { AppNavLinks, NavLinks } from "../sidebar/AppNav";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SETTINGS_SECTIONS } from "./settingsSections";

export function SettingsSidebarNav() {
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <AppNavLinks />
        <SidebarGroup>
          <SidebarMenu>
            <NavLinks
              links={SETTINGS_SECTIONS.filter((section) => section.to !== "/settings/runner")}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
