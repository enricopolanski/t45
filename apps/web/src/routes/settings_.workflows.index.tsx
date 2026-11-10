import { createFileRoute } from "@tanstack/react-router";
import { WorkflowList } from "../components/workflows/Workflows";
export const Route = createFileRoute("/settings_/workflows/")({
  component: WorkflowList,
});
