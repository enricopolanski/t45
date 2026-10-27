import { createFileRoute } from "@tanstack/react-router";
import { NewWorkflowDefinition } from "../components/workflows/WorkflowDefinitions";
export const Route = createFileRoute("/workflow-blueprints/new")({
  component: NewWorkflowDefinition,
});
