import { CalendarClockIcon, ServerIcon, UsersIcon } from "lucide-react";

import type { NavLink } from "../sidebar/AppNav";

/**
 * Settings' sections in sidebar order. The sidebar nav and the breadcrumb both render from this
 * list, so each label exists once; Runner's link sits with the AI Team links instead.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<NavLink> = [
  { to: "/settings/runner", label: "Runner", icon: <ServerIcon /> },
  { to: "/settings/automations", label: "Automations", icon: <CalendarClockIcon /> },
  { to: "/settings/members", label: "Members", icon: <UsersIcon /> },
];
