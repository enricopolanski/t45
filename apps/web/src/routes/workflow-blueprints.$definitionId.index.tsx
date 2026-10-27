import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDefinitionEditor } from "../components/workflows/WorkflowDefinitions";
function DefinitionRouteView() {
  const { definitionId } = Route.useParams();
  return <WorkflowDefinitionEditor key={definitionId} definitionId={definitionId} />;
}
export const Route = createFileRoute("/workflow-blueprints/$definitionId/")({
  component: DefinitionRouteView,
});
