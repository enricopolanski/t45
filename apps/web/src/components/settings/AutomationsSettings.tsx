import { appAtomRegistry } from "../../state/atomRegistry";
import { ArchiveIcon, MoreHorizontalIcon, PencilIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { canUse } from "@t45/contracts/models/Agent";
import type { Automation } from "@t45/contracts/models/Automation";
import type { AutomationSummary } from "@t45/contracts/resources/Automations";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { agentsList, stepAutomationList } from "../../state/agents";
import { useNowMinute } from "../../hooks/useNowMinute";
import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { apiQuery, useApiQuery } from "../../state/rpc";
import { useSession } from "../../state/session";

import { EMPTY_DRAFT, settingsFromDraft, type DraftState } from "./automationsSettings.logic";
import { Field, Fieldset } from "../ui/field";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  SettingsEmpty,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const automationList = apiQuery("automations.list")(undefined);

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

export function AutomationsSettings() {
  const automationsQuery = useApiQuery(automationList);
  const automations = automationsQuery.data;
  const [editor, setEditor] = useState<{ automation: Automation | null } | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Automations"
        description="Define reusable agent jobs for steps."
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={automationsQuery.refresh}
              disabled={automationsQuery.isPending}
            >
              Refresh runs
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditor({ automation: null })}>
              New automation
            </Button>
          </div>
        }
      >
        {automationsQuery.error ? (
          <SettingsRow title="Could not load automations" description={automationsQuery.error} />
        ) : !automations ? (
          <SettingsRow title="Loading automations…" />
        ) : automations.length === 0 ? (
          <SettingsEmpty>No automations yet.</SettingsEmpty>
        ) : (
          automations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              onEdit={() => setEditor({ automation })}
              onChanged={automationsQuery.refresh}
            />
          ))
        )}
      </SettingsSection>
      {editor ? (
        <AutomationEditorDialog
          automation={editor.automation}
          onSaved={automationsQuery.refresh}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

/** Runs `work`, reports its failure under `title`, and refreshes the list either way. */
function useRowAction(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const act = async (title: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      reportFailure(title, describeFailure(error));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return { busy, act };
}

function AutomationRow({
  automation,
  onEdit,
  onChanged,
}: {
  readonly automation: AutomationSummary;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const { busy, act } = useRowAction(onChanged);
  const now = useNowMinute();
  const runNow = () =>
    act("Could not run automation", async () => {
      await api("automations.runNow", { id: automation.id });
      toastManager.add({ type: "success", title: "Run started" });
    });
  return (
    <SettingsRow
      title={automation.title}
      description={<span className="line-clamp-2">{automation.prompt}</span>}
      status={
        automation.lastRun !== null && (
          <p>
            Last run: {automation.lastRun.statusLabel} ·{" "}
            {formatRelativeTimeLabel(automation.lastRun.at, now)}
          </p>
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Actions for ${automation.title}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>
              <PencilIcon />
              Edit
            </MenuItem>
            <MenuItem onClick={() => void runNow()}>
              <PlayIcon />
              Run now
            </MenuItem>
            <MenuItem
              variant="destructive"
              onClick={() =>
                void act("Could not archive automation", () =>
                  api("automations.archive", { id: automation.id }),
                )
              }
            >
              <ArchiveIcon />
              Archive for good
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    />
  );
}

function AutomationEditorDialog({
  automation,
  onSaved,
  onClose,
}: {
  readonly automation: Automation | null;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const agentsQuery = useApiQuery(agentsList);
  const userId = useSession()?.userId;
  // An admin also lists other people's private agents, to manage them and never to run them.
  const activeAgents =
    agentsQuery.data?.filter(
      (agent) => agent.status === "active" && userId !== undefined && canUse(agent, userId),
    ) ?? null;
  const [draft, setDraft] = useState<DraftState>(automation ?? EMPTY_DRAFT);
  const patch = (change: Partial<DraftState>) => setDraft((current) => ({ ...current, ...change }));
  const [saving, setSaving] = useState(false);

  // A new automation runs on the first active agent until another is picked.
  const agentId = draft.agentId ?? activeAgents?.[0]?.id ?? null;
  const agentName =
    agentsQuery.error ??
    (activeAgents === null
      ? "Loading agents…"
      : (activeAgents.find((agent) => agent.id === agentId)?.name ??
        (agentId ? "An archived or private agent" : "No active agents")));

  const submit = async () => {
    const checked = settingsFromDraft({ ...draft, agentId });
    if ("problem" in checked) {
      reportFailure(checked.problem.title, checked.problem.description);
      return;
    }
    // Stays saving through a successful save, until the dialog closes.
    setSaving(true);
    try {
      await (automation
        ? api("automations.update", { id: automation.id, ...checked.settings })
        : api("automations.create", checked.settings));
      appAtomRegistry.refresh(stepAutomationList);
      onSaved();
      onClose();
    } catch (error) {
      setSaving(false);
      reportFailure("Could not save automation", describeFailure(error));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            Changes apply everywhere this automation is used, on its next run.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <Fieldset disabled={saving}>
            <Field label="Name">
              <Input
                maxLength={200}
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </Field>

            <Field label="Prompt">
              <Textarea
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
              />
            </Field>

            <Field label="Agent">
              <Select
                value={agentId}
                disabled={!activeAgents?.length}
                onValueChange={(value) =>
                  patch({ agentId: activeAgents?.find((agent) => agent.id === value)?.id ?? null })
                }
              >
                <SelectTrigger size="sm">
                  <SelectValue>{agentName}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(activeAgents ?? []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </Fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {automation ? "Save automation" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
