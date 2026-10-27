import { BotIcon, CalendarClockIcon, ServerIcon, UsersIcon, WorkflowIcon } from "lucide-react";

import type { NavLink } from "../sidebar/AppNav";

/**
 * Settings' sections by group, in sidebar order. The sidebar nav and the breadcrumb both render
 * from this list, so each label exists once.
 */
export const SETTINGS_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly links: ReadonlyArray<NavLink>;
}> = [
  {
    label: "Work",
    links: [
      { to: "/settings/workflows", label: "Workflows", icon: <WorkflowIcon /> },
      { to: "/settings/automations", label: "Automations", icon: <CalendarClockIcon /> },
    ],
  },
  {
    label: "AI Team",
    links: [
      { to: "/settings/agents", label: "Agents", icon: <BotIcon /> },
      { to: "/settings/runner", label: "Runner", icon: <ServerIcon /> },
    ],
  },
  {
    label: "Organization",
    links: [{ to: "/settings/organization", label: "Organization", icon: <UsersIcon /> }],
  },
];
