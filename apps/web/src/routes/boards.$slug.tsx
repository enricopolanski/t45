import { createFileRoute } from "@tanstack/react-router";

import { WorkflowBoardPage } from "../components/workflows/WorkflowBoardPage";

function BoardRouteView() {
  const { slug } = Route.useParams();
  return <WorkflowBoardPage key={slug} workflowId={slug} />;
}

export const Route = createFileRoute("/boards/$slug")({
  component: BoardRouteView,
});
