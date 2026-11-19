import { useTranslation } from "~/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";

import { WorkFrame } from "../components/work/WorkFrame";
import { AgentList } from "../components/agents/AgentList";

function AgentsIndexView() {
  const t = useTranslation();
  return (
    <WorkFrame title={t("Agents")}>
      <AgentList />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/")({
  component: AgentsIndexView,
});
