import { CopyIcon, MoreHorizontalIcon, PencilIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { type Schedule, type Automation } from "@t45/contracts/models/Automation";

import { formatScheduledLabel } from "../../timestampFormat";
import { agentsList } from "../../state/agents";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { apiQuery, useApiQuery } from "../../state/rpc";

import {
  EMPTY_DRAFT,
  browserTimeZone,
  settingsFromDraft,
  automationToDraft,
  webhookPath,
  type DraftState,
} from "./automationsSettings.logic";
import { Field, Fieldset, SwitchField } from "../ui/field";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Button } from "../ui/button";
import {
  AlertDialog,
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

/** Prompt a new webhook automation starts with: just the body, so request headers stay out unless the user adds them. */
const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

const webhookUrl = (automation: Automation) => {
  const path = webhookPath(automation);
  return path === null ? null : new URL(path, window.location.origin).href;
};

function scheduleLabel(schedule: Schedule) {
  if (schedule.type === "webhook") return "On webhook";
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
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Automations"
        description="Run agents on a schedule or when a webhook is received."
        action={
          <Button size="sm" variant="outline" onClick={() => setEditor({ automation: null })}>
            New automation
          </Button>
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

function AutomationRow({
  automation,
  onEdit,
  onChanged,
}: {
  readonly automation: Automation;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"rotate" | null>(null);
  const now = useNowMinute();
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Webhook URL copied" }),
    onError: () => toastManager.add({ type: "error", title: "Could not copy webhook URL" }),
  });
  const isWebhook = automation.schedule.type === "webhook";
  const url = webhookUrl(automation);
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
  const toggle = () =>
    act("Could not update automation", async () => {
      await api("automations.setEnabled", { id: automation.id, isEnabled: !automation.isEnabled });
    });
  const runNow = () =>
    act("Could not run automation", async () => {
      await api("automations.runNow", { id: automation.id });
      toastManager.add({
        type: "success",
        title: "Run started",
      });
    });
  const rotate = () =>
    act("Could not rotate webhook URL", async () => {
      const rotated = webhookUrl(await api("automations.rotateToken", { id: automation.id }));
      toastManager.add({
        type: "success",
        title: "Webhook URL rotated",
        ...(rotated === null
          ? {}
          : { actionProps: { children: "Copy URL", onClick: () => copyToClipboard(rotated) } }),
      });
    });
  return (
    <SettingsRow
      title={automation.title}
      description={<span className="line-clamp-2">{automation.prompt}</span>}
      status={
        <div className="space-y-1">
          <p>
            {scheduleLabel(automation.schedule)} ·{" "}
            {!automation.isEnabled
              ? "Paused"
              : isWebhook
                ? "Listening"
                : automation.nextRunAt
                  ? `Next run ${formatScheduledLabel(automation.nextRunAt, now)}`
                  : "Not scheduled"}
          </p>
          {automation.lastError ? <p className="text-destructive">{automation.lastError}</p> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={automation.isEnabled}
            disabled={busy}
            aria-label={`Enable ${automation.title}`}
            onCheckedChange={() => void toggle()}
          />
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
              {isWebhook ? (
                <>
                  {url === null ? null : (
                    <MenuItem onClick={() => copyToClipboard(url)}>
                      <CopyIcon />
                      Copy URL
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => setConfirming("rotate")}>
                    <RefreshCwIcon />
                    Rotate URL
                  </MenuItem>
                </>
              ) : (
                <MenuItem onClick={() => void runNow()}>
                  <PlayIcon />
                  Run now
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
          <AlertDialog
            open={confirming !== null}
            onOpenChange={(open) => {
              if (!open) setConfirming(null);
            }}
          >
            <DialogPopup closeButton={false}>
              <DialogHeader>
                <DialogTitle>Rotate this webhook URL?</DialogTitle>
                <DialogDescription>The current URL stops working.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirming(null);
                    void rotate();
                  }}
                >
                  Confirm
                </Button>
              </DialogFooter>
            </DialogPopup>
          </AlertDialog>
        </div>
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
  const activeAgents = agentsQuery.data?.filter((agent) => agent.status === "active") ?? null;
  const [draft, setDraft] = useState(() =>
    automation ? automationToDraft(automation) : EMPTY_DRAFT,
  );
  const patch = (change: Partial<DraftState>) => setDraft((current) => ({ ...current, ...change }));
  const [saving, setSaving] = useState(false);

  // A new automation runs on the first active agent until another is picked.
  const agentId = draft.agentId ?? activeAgents?.[0]?.id ?? null;
  const agentName =
    agentsQuery.error ??
    (activeAgents === null
      ? "Loading agents…"
      : (activeAgents.find((agent) => agent.id === agentId)?.name ??
        (agentId ? "An archived agent" : "No active agents")));

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
            Run a prompt automatically — on an interval, at a fixed time, or when a webhook is
            called.
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

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0];
                    if (mode === "fixed" || mode === "interval" || mode === "webhook")
                      setDraft((current) => ({
                        ...current,
                        scheduleMode: mode,
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      }));
                  }}
                >
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                  <Toggle value="webhook">On webhook</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "webhook" ? (
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    {
                      "Each request to the automation's URL runs the prompt; copy the URL from the automation's menu once saved. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  </p>
                  <SwitchField
                    label="Require signature"
                    description="Reject requests without a valid HMAC-SHA256 signature of the body."
                    checked={draft.isSignatureRequired}
                    onCheckedChange={(isSignatureRequired) => patch({ isSignatureRequired })}
                  />
                  {draft.isSignatureRequired ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Header">
                        <Input
                          value={draft.signatureHeader}
                          onChange={(event) => patch({ signatureHeader: event.target.value })}
                        />
                      </Field>
                      <Field label="Prefix">
                        <Input
                          value={draft.signaturePrefix}
                          placeholder="None"
                          onChange={(event) => patch({ signaturePrefix: event.target.value })}
                        />
                      </Field>
                      <Field label="Encoding">
                        <Select
                          value={draft.signatureEncoding}
                          onValueChange={(value) =>
                            patch({ signatureEncoding: value === "base64" ? "base64" : "hex" })
                          }
                        >
                          <SelectTrigger size="sm">
                            <SelectValue>{draft.signatureEncoding}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="hex">hex</SelectItem>
                            <SelectItem value="base64">base64</SelectItem>
                          </SelectPopup>
                        </Select>
                      </Field>
                      <Field label="Secret">
                        <Input
                          autoComplete="off"
                          spellCheck={false}
                          value={draft.signatureSecret}
                          placeholder="Shared secret"
                          onChange={(event) => patch({ signatureSecret: event.target.value })}
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : draft.scheduleMode === "fixed" ? (
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
            </div>

            <SwitchField
              label="Enabled"
              description="Disabled automations stay saved but do not run."
              checked={draft.isEnabled}
              onCheckedChange={(isEnabled) => patch({ isEnabled })}
            />
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
