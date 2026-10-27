import { createFileRoute } from "@tanstack/react-router";

import { AgentsFrame } from "../components/agents/AgentsFrame";
import { AgentList } from "../components/agents/AgentList";

function AgentsIndexView() {
  return (
    <AgentsFrame title="Agents" back={false}>
      <AgentList />
    </AgentsFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/")({
  component: AgentsIndexView,
});
