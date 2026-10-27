import { createFileRoute } from "@tanstack/react-router";

import { WorkFrame } from "../components/work/WorkFrame";
import { SkillEditor } from "../components/agents/SkillEditor";

function NewSkillView() {
  return (
    <WorkFrame title="New skill">
      <SkillEditor skillId={null} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/skills/new")({
  component: NewSkillView,
});
