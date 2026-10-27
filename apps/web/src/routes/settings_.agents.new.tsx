import { createFileRoute } from "@tanstack/react-router";

import { AgentEditor } from "../components/agents/AgentEditor";
import { WorkFrame } from "../components/work/WorkFrame";

function NewAgentView() {
  return (
    <WorkFrame title="New agent">
      <AgentEditor agentId={null} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/new")({
  component: NewAgentView,
});
