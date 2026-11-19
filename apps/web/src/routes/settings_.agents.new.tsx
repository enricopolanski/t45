import { useTranslation } from "~/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";

import { AgentEditor } from "../components/agents/AgentEditor";
import { WorkFrame } from "../components/work/WorkFrame";

function NewAgentView() {
  const t = useTranslation();
  return (
    <WorkFrame title={t("New agent")}>
      <AgentEditor agentId={null} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/new")({
  component: NewAgentView,
});
