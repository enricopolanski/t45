import { createFileRoute } from "@tanstack/react-router";

import { ProjectList } from "../components/workflows/ProjectList";

export const Route = createFileRoute("/settings_/projects/")({
  component: ProjectList,
});
