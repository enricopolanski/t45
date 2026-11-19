import { useTranslation } from "~/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";

import { WorkFrame } from "../components/work/WorkFrame";
import { SkillEditor } from "../components/agents/SkillEditor";

function NewSkillView() {
  const t = useTranslation();
  return (
    <WorkFrame title={t("New skill")}>
      <SkillEditor skillId={null} />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/settings_/agents/skills/new")({
  component: NewSkillView,
});
