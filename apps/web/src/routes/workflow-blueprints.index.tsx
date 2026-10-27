import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDefinitions } from "../components/workflows/WorkflowDefinitions";
export const Route = createFileRoute("/workflow-blueprints/")({ component: WorkflowDefinitions });
