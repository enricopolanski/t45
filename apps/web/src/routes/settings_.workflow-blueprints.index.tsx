import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDefinitions } from "../components/workflows/WorkflowDefinitions";
export const Route = createFileRoute("/settings_/workflow-blueprints/")({
  component: WorkflowDefinitions,
});
