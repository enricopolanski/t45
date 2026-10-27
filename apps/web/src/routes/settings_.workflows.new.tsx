import { createFileRoute } from "@tanstack/react-router";
import { NewWorkflow } from "../components/workflows/NewWorkflow";
function NewWorkflowRoute() {
  const { definitionId } = Route.useSearch();
  return <NewWorkflow key={definitionId ?? "new"} definitionId={definitionId} />;
}
export const Route = createFileRoute("/settings_/workflows/new")({
  validateSearch: (search: Record<string, unknown>): { definitionId?: string } =>
    typeof search.definitionId === "string" ? { definitionId: search.definitionId } : {},
  component: NewWorkflowRoute,
});
