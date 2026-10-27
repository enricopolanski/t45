import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditor } from "../components/workflows/WorkflowEditor";

function EditorRouteView() {
  const { workflowId } = Route.useParams();
  return <WorkflowEditor key={workflowId} workflowId={workflowId} />;
}

export const Route = createFileRoute("/workflows/$workflowId/edit/")({
  component: EditorRouteView,
});
