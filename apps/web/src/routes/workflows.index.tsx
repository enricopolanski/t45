import { createFileRoute } from "@tanstack/react-router";

import { WorkflowList } from "../components/workflows/WorkflowList";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowList,
});
