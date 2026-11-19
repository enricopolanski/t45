import { useTranslation } from "~/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";

import { SettingsEmpty, SettingsPageContainer } from "../components/settings/settingsLayout";

function AutomationBenchmarks() {
  const t = useTranslation();
  return (
    <SettingsPageContainer>
      <SettingsEmpty>{t("No benchmarks yet.")}</SettingsEmpty>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/automations/benchmarks")({
  component: AutomationBenchmarks,
});
