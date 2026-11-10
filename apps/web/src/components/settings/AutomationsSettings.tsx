import { appAtomRegistry } from "../../state/atomRegistry";
import {
  ArchiveIcon,
  CalendarPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { useState } from "react";
import { canUse } from "@t45/contracts/models/Agent";
import {
  type Automation,
  type Schedule,
  type ScheduleTrigger,
} from "@t45/contracts/models/Automation";
import type { AutomationSummary } from "@t45/contracts/resources/Automations";

import { formatRelativeTimeLabel, formatScheduledLabel } from "../../timestampFormat";
import { agentsList, stepAutomationList } from "../../state/agents";
import { useNowMinute } from "../../hooks/useNowMinute";
import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { apiQuery, useApiQuery } from "../../state/rpc";
import { useSession } from "../../state/session";
import { usersList } from "../../state/users";

import {
  EMPTY_DRAFT,
  EMPTY_SCHEDULE,
  browserTimeZone,
  scheduleFromDraft,
  settingsFromDraft,
  type DraftState,
  type ScheduleDraft,
} from "./automationsSettings.logic";
import { ErrorText } from "../ui/error-text";
import { Field, Fieldset } from "../ui/field";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  SettingsEmpty,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const automationList = apiQuery("automations.list")(undefined);

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

function scheduleLabel(schedule: Schedule) {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const { weekdays } = schedule;
  const days =
    weekdays.length === 7
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = schedule.timeZone === browserTimeZone() ? "" : ` (${schedule.timeZone})`;
  return `${days} at ${schedule.timeOfDay}${zone}`;
}

export function AutomationsSettings() {
  const automationsQuery = useApiQuery(automationList);
  const automations = automationsQuery.data;
  const [editor, setEditor] = useState<{ automation: Automation | null } | null>(null);
  const [scheduled, setScheduled] = useState<Automation | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Automations"
        description="Define reusable agent jobs for steps and schedules."
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
              onSchedule={() => setScheduled(automation)}
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
      {scheduled ? (
        <ScheduleDialog
          automation={scheduled}
          onSaved={automationsQuery.refresh}
          onClose={() => setScheduled(null)}
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
  onSchedule,
  onChanged,
}: {
  readonly automation: AutomationSummary;
  readonly onEdit: () => void;
  readonly onSchedule: () => void;
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
        <div className="space-y-1">
          {automation.scheduleTriggers.length === 0 ? <p>On demand</p> : null}
          {automation.scheduleTriggers.map((trigger) => (
            <ScheduleRow key={trigger.id} trigger={trigger} now={now} onChanged={onChanged} />
          ))}
          {automation.lastRun !== null && (
            <p>
              Last run: {automation.lastRun.statusLabel} ·{" "}
              {formatRelativeTimeLabel(automation.lastRun.at, now)}
            </p>
          )}
        </div>
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
            <MenuItem onClick={onSchedule}>
              <CalendarPlusIcon />
              Add schedule
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    />
  );
}

/** One schedule of an automation. Anyone here pauses or archives it; only its creator resumes it. */
function ScheduleRow({
  trigger,
  now,
  onChanged,
}: {
  readonly trigger: ScheduleTrigger;
  readonly now: number;
  readonly onChanged: () => void;
}) {
  const { busy, act } = useRowAction(onChanged);
  const isMine = useSession()?.userId === trigger.creatorUserId;
  const creator = useApiQuery(usersList).data?.find((user) => user.id === trigger.creatorUserId);
  const isEnabled = trigger.status === "enabled";
  const label = scheduleLabel(trigger.schedule);
  return (
    <>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1">
          {label} ·{" "}
          {!isEnabled
            ? "Paused"
            : trigger.nextRunAt
              ? `Next run ${formatScheduledLabel(trigger.nextRunAt, now)}`
              : "Ready"}{" "}
          · as {isMine ? "you" : (creator?.displayName ?? "someone")}
        </p>
        <Switch
          size="sm"
          checked={isEnabled}
          disabled={busy || (!isEnabled && !isMine)}
          aria-label={`Enable ${label}`}
          onCheckedChange={(isEnabled) =>
            void act("Could not update schedule", async () => {
              await api("automations.setScheduleTriggerEnabled", { id: trigger.id, isEnabled });
            })
          }
        />
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={`Archive ${label}`}
          onClick={() =>
            void act("Could not archive schedule", () =>
              api("automations.archiveScheduleTrigger", { id: trigger.id }),
            )
          }
        >
          <ArchiveIcon />
        </Button>
      </div>
      {trigger.lastError && <ErrorText text={trigger.lastError} />}
    </>
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

function ScheduleDialog({
  automation,
  onSaved,
  onClose,
}: {
  readonly automation: Automation;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(EMPTY_SCHEDULE);
  const patch = (change: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const checked = scheduleFromDraft(draft);
    if ("problem" in checked) {
      reportFailure(checked.problem.title, checked.problem.description);
      return;
    }
    // Stays saving through a successful save, until the dialog closes.
    setSaving(true);
    try {
      await api("automations.createScheduleTrigger", {
        automationId: automation.id,
        schedule: checked.schedule,
      });
      onSaved();
      onClose();
    } catch (error) {
      setSaving(false);
      reportFailure("Could not add schedule", describeFailure(error));
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
          <DialogTitle>Add schedule</DialogTitle>
          <DialogDescription>
            {automation.title} runs on this schedule as you, for as long as you could run it
            yourself.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <Fieldset disabled={saving}>
            <ToggleGroup
              aria-label="Schedule type"
              value={[draft.mode]}
              onValueChange={(values) => {
                const mode = values[0];
                if (mode === "fixed" || mode === "interval") patch({ mode });
              }}
            >
              <Toggle value="fixed">At a time</Toggle>
              <Toggle value="interval">Every interval</Toggle>
            </ToggleGroup>

            {draft.mode === "fixed" ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-automation-time">Run at</Label>
                  <Input
                    type="time"
                    id="scheduled-automation-time"
                    className="w-32"
                    value={draft.timeOfDay}
                    onChange={(event) => patch({ timeOfDay: event.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">on</span>
                </div>
                <ToggleGroup
                  multiple
                  variant="outline"
                  aria-label="Days to run"
                  value={[...draft.weekdays].map(String)}
                  onValueChange={(values) => {
                    if (values.length > 0) patch({ weekdays: new Set(values.map(Number)) });
                  }}
                >
                  {WEEKDAY_ORDER.map((day) => (
                    <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                      {WEEKDAY_LABELS[day].slice(0, 2)}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-automation-interval">Run every</Label>
                <Input
                  type="number"
                  id="scheduled-automation-interval"
                  min={1}
                  step="any"
                  className="w-24"
                  value={draft.intervalMinutes}
                  onChange={(event) => patch({ intervalMinutes: event.target.value })}
                />
                <span className="text-xs text-muted-foreground">minutes</span>
              </div>
            )}
          </Fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            Add schedule
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
