import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry";
import { useLoaded } from "./query";
import { apiQuery, apiWatch } from "./rpc";

const myWork = apiQuery("assignments.listAssignments")(undefined).pipe(Atom.refreshOnWindowFocus);
export const notifications = apiQuery("notifications.list")(undefined).pipe(
  Atom.withRefresh("30 seconds"),
  Atom.refreshOnWindowFocus,
);

const startable = apiQuery("workflows.listStartableProjects")(undefined);
export const stepViews = apiWatch("workflows.watchStep", { idleTtlMs: 0 });

export const useMyWork = () => useLoaded(myWork);
export const useStartableProjects = () => useLoaded(startable);

/** What starting a ticket asks changes with each version a project adopts. */
export const refreshStartableProjects = () => appAtomRegistry.refresh(startable);

export function workChanged() {
  appAtomRegistry.refresh(myWork);
  appAtomRegistry.refresh(notifications);
}
