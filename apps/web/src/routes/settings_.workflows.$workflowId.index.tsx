import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditor } from "../components/workflows/Workflows";
function WorkflowRouteView() {
  const { workflowId } = Route.useParams();
  return <WorkflowEditor key={workflowId} workflowId={workflowId} />;
}
export const Route = createFileRoute("/settings_/workflows/$workflowId/")({
  component: WorkflowRouteView,
});
