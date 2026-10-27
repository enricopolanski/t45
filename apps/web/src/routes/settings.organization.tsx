import { createFileRoute } from "@tanstack/react-router";

import { MembersSettings } from "../components/settings/MembersSettings";

export const Route = createFileRoute("/settings/organization")({
  component: MembersSettings,
});
