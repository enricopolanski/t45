import { createFileRoute } from "@tanstack/react-router";
import { NewWorkflow } from "../components/workflows/Workflows";
export const Route = createFileRoute("/settings_/workflows/new")({
  component: NewWorkflow,
});
