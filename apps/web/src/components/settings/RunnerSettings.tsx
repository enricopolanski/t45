import type { RunnerStatus } from "@t45/contracts/resources/Runner";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { apiQuery, useApiQuery } from "../../state/rpc";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import {
  SettingsEmpty,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const runnerStatus = apiQuery("runner.get")(undefined).pipe(Atom.withRefresh("5 seconds"));

type RunnerVm = RunnerStatus["vms"][number];

const VM_STATES = {
  starting: { label: "Starting", variant: "outline" },
  running: { label: "Running", variant: "info" },
  stopped: { label: "Stopped", variant: "secondary" },
} as const satisfies Record<RunnerVm["state"], object>;

function vmDetails(vm: RunnerVm) {
  const usage =
    vm.connections > 0 ? "in use" : `last used ${formatRelativeTimeLabel(vm.lastActiveAt)}`;
  return vm.chat === null
    ? usage
    : [vm.chat.agentName ?? "An agent no longer set up for chat", usage].join(" · ");
}

/**
 * The runner, the machine agents' chats run on: whether it is available, and each chat's VM.
 * Refreshes while open.
 */
export function RunnerSettings() {
  const { data: status, error } = useApiQuery(runnerStatus);

  return (
    <SettingsPageContainer>
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      <SettingsSection title="Runner" description="The machine that runs agents' chats.">
        <SettingsRow
          title="Status"
          description={
            status === null
              ? "Asking the runner…"
              : status.isAvailable
                ? undefined
                : (status.reason ?? "The runner is unavailable.")
          }
          control={
            status === null ? null : status.isAvailable ? (
              <Badge variant="success">Online</Badge>
            ) : (
              <Badge variant="error">Unavailable</Badge>
            )
          }
        />
      </SettingsSection>
      {status?.isAvailable ? (
        <SettingsSection title="Chats" description="Chat environments on this runner.">
          {status.vms.length === 0 ? (
            <SettingsEmpty>No chat has run since the runner started.</SettingsEmpty>
          ) : (
            status.vms.map((vm) => (
              <SettingsRow
                key={vm.vmId}
                title={
                  vm.chat === null ? (
                    "A chat you can't open"
                  ) : (
                    <Link
                      to="/chats/$chatId"
                      params={{ chatId: vm.chat.id }}
                      className="hover:underline"
                    >
                      {vm.chat.title}
                    </Link>
                  )
                }
                description={vmDetails(vm)}
                control={
                  <Badge variant={VM_STATES[vm.state].variant}>{VM_STATES[vm.state].label}</Badge>
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
