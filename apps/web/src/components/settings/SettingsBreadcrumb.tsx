import { PageBreadcrumb, PageBreadcrumbItem, PageBreadcrumbSeparator } from "../PageBreadcrumb";
import { SETTINGS_GROUPS } from "./settingsSections";

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = SETTINGS_GROUPS.flatMap((group) => group.links).find(
    (section) => section.to === pathname,
  )?.label;

  return (
    <PageBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <PageBreadcrumbItem>Settings</PageBreadcrumbItem>
          <PageBreadcrumbSeparator />
        </>
      ) : null}
      <PageBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </PageBreadcrumbItem>
    </PageBreadcrumb>
  );
}
