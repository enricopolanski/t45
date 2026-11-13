import { createFileRoute } from "@tanstack/react-router";

import { PeopleSettings } from "../components/settings/OrganizationSettings";

export const Route = createFileRoute("/settings/people")({
  component: PeopleSettings,
});
