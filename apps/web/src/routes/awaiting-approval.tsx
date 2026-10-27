import { createFileRoute } from "@tanstack/react-router";

import { AwaitingApprovalSurface } from "../components/auth/AwaitingApprovalSurface";

export const Route = createFileRoute("/awaiting-approval")({
  component: AwaitingApprovalSurface,
});
