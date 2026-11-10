import { createFileRoute } from "@tanstack/react-router";

import { ProjectEditor } from "../components/workflows/ProjectEditor";

function EditorRouteView() {
  const { projectId } = Route.useParams();
  return <ProjectEditor key={projectId} projectId={projectId} />;
}

export const Route = createFileRoute("/settings_/projects/$projectId/edit/")({
  component: EditorRouteView,
});
