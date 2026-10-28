import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry";
import { useLoaded } from "./query";
import { apiQuery } from "./rpc";

const myWork = apiQuery("assignments.listAssignments")(undefined).pipe(Atom.refreshOnWindowFocus);
export const notifications = apiQuery("notifications.list")(undefined).pipe(
  Atom.withRefresh("30 seconds"),
  Atom.refreshOnWindowFocus,
);

const startable = apiQuery("workflows.listStartableInstances")(undefined);

export const useMyWork = () => useLoaded(myWork).sections;
export const useStartableWorkflows = () => useLoaded(startable);

export function workChanged() {
  appAtomRegistry.refresh(myWork);
  appAtomRegistry.refresh(notifications);
}
