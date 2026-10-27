import { createFileRoute } from "@tanstack/react-router";

import { AgentEditor } from "../components/agents/AgentEditor";
import { WorkFrame } from "../components/work/WorkFrame";

function EditAgentView() {
  const { agentId } = Route.useParams();
  return (
    <WorkFrame key={agentId} title="Edit agent">
      <AgentEditor agentId={agentId} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/$agentId")({
  component: EditAgentView,
});
