import { createFileRoute } from "@tanstack/react-router";

import { WorkFrame } from "../components/work/WorkFrame";
import { AgentList } from "../components/agents/AgentList";

function AgentsIndexView() {
  return (
    <WorkFrame title="Agents">
      <AgentList />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/")({
  component: AgentsIndexView,
});
