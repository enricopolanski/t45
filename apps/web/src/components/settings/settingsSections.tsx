import {
  BotIcon,
  Building2Icon,
  CalendarClockIcon,
  DatabaseIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";

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
      { to: "/settings/projects", label: "Projects", icon: <WorkflowIcon /> },
      {
        to: "/settings/automations",
        label: "Automations",
        icon: <CalendarClockIcon />,
        children: [
          { to: "/settings/automations/runs", label: "Runs" },
          { to: "/settings/automations/benchmarks", label: "Benchmarks" },
        ],
      },
      { to: "/settings/collections", label: "Collections", icon: <DatabaseIcon /> },
    ],
  },
  {
    label: "AI Team",
    links: [{ to: "/settings/agents", label: "Agents", icon: <BotIcon /> }],
  },
  {
    label: "Organization",
    links: [
      { to: "/settings/organization", label: "Organization", icon: <Building2Icon /> },
      { to: "/settings/people", label: "People", icon: <UsersIcon /> },
    ],
  },
];
