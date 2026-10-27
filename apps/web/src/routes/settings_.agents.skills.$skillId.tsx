import { createFileRoute } from "@tanstack/react-router";

import { WorkFrame } from "../components/work/WorkFrame";
import { SkillEditor } from "../components/agents/SkillEditor";

function EditSkillView() {
  const { skillId } = Route.useParams();
  return (
    <WorkFrame key={skillId} title="Edit skill">
      <SkillEditor skillId={skillId} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/skills/$skillId")({
  component: EditSkillView,
});
