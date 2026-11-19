import { useTranslation } from "~/i18n/locale";
import { SidebarContent } from "../ui/sidebar";
import { AppNavGroup, NavLinks } from "../sidebar/AppNav";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SETTINGS_GROUPS } from "./settingsSections";

export function SettingsSidebarNav() {
  const t = useTranslation();
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_GROUPS.map((group) => (
          <AppNavGroup key={group.label} label={t(group.label)}>
            <NavLinks links={group.links} />
          </AppNavGroup>
        ))}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
