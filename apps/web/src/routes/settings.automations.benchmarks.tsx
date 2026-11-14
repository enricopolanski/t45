import { createFileRoute } from "@tanstack/react-router";

import { SettingsEmpty, SettingsPageContainer } from "../components/settings/settingsLayout";

function AutomationBenchmarks() {
  return (
    <SettingsPageContainer>
      <SettingsEmpty>No benchmarks yet.</SettingsEmpty>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/automations/benchmarks")({
  component: AutomationBenchmarks,
});
