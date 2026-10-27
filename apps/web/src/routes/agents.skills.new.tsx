import { createFileRoute } from "@tanstack/react-router";

import { AgentsFrame } from "../components/agents/AgentsFrame";
import { SkillEditor } from "../components/agents/SkillEditor";

function NewSkillView() {
  return (
    <AgentsFrame title="New skill" back>
      <SkillEditor skillId={null} />
    </AgentsFrame>
  );
}

export const Route = createFileRoute("/agents/skills/new")({
  component: NewSkillView,
});
