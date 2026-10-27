import { createRouter } from "@tanstack/react-router";

import { PaddedError, PaddedPending } from "./components/Loading";
import { NotFound } from "./components/NotFound";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: PaddedPending,
  defaultErrorComponent: PaddedError,
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
