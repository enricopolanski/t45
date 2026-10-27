import { createFileRoute } from "@tanstack/react-router";

import { AgentEditor } from "../components/agents/AgentEditor";
import { AgentsFrame } from "../components/agents/AgentsFrame";

function EditAgentView() {
  const { agentId } = Route.useParams();
  return (
    <AgentsFrame key={agentId} title="Edit agent" back>
      <AgentEditor agentId={agentId} />
    </AgentsFrame>
  );
}

export const Route = createFileRoute("/agents/$agentId")({
  component: EditAgentView,
});
