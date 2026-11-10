import { createFileRoute } from "@tanstack/react-router";
import { NewProject } from "../components/workflows/NewProject";
function NewProjectRoute() {
  const { workflowId } = Route.useSearch();
  return <NewProject key={workflowId ?? "new"} workflowId={workflowId} />;
}
export const Route = createFileRoute("/settings_/projects/new")({
  validateSearch: (search: Record<string, unknown>): { workflowId?: string } =>
    typeof search.workflowId === "string" ? { workflowId: search.workflowId } : {},
  component: NewProjectRoute,
});
