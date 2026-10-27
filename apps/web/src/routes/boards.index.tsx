import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/boards/")({
  beforeLoad: () => {
    throw redirect({ to: "/my-work", replace: true });
  },
});
