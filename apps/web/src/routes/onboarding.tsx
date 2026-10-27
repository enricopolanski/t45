import { createFileRoute } from "@tanstack/react-router";

import { OrganizationOnboarding } from "../components/onboarding/OrganizationOnboarding";

export const Route = createFileRoute("/onboarding")({
  component: OrganizationOnboarding,
});
