import { createFileRoute } from "@tanstack/react-router";

import { AgentsFrame } from "../components/agents/AgentsFrame";
import { SkillEditor } from "../components/agents/SkillEditor";

function EditSkillView() {
  const { skillId } = Route.useParams();
  return (
    <AgentsFrame key={skillId} title="Edit skill" back>
      <SkillEditor skillId={skillId} />
    </AgentsFrame>
  );
}

export const Route = createFileRoute("/agents/skills/$skillId")({
  component: EditSkillView,
});
