import { createFileRoute } from "@tanstack/react-router";

import { ProjectBoardPage } from "../components/workflows/ProjectBoardPage";

function BoardRouteView() {
  const { slug } = Route.useParams();
  return <ProjectBoardPage key={slug} projectId={slug} />;
}

export const Route = createFileRoute("/boards/$slug")({
  component: BoardRouteView,
});
