import { createFileRoute } from "@tanstack/react-router";

import { AgentEditor } from "../components/agents/AgentEditor";
import { AgentsFrame } from "../components/agents/AgentsFrame";

function NewAgentView() {
  return (
    <AgentsFrame title="New agent" back>
      <AgentEditor agentId={null} />
    </AgentsFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/new")({
  component: NewAgentView,
});
