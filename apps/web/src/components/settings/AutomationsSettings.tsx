import type { Automation, AutomationId } from "@t45/contracts/models/Automation";
import { canUse } from "@t45/contracts/models/Agent";
import type { AutomationRun, AutomationSummary } from "@t45/contracts/resources/Automations";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  ArchiveIcon,
  BotIcon,
  CalendarIcon,
  CirclePlayIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { agentsList, stepAutomationList } from "../../state/agents";
import { appAtomRegistry } from "../../state/atomRegistry";
import { apiWatch, useApiQuery } from "../../state/rpc";
import { useSession } from "../../state/session";
import { stepViews } from "../../state/work";
import { formatDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { ProgressReport } from "../ProgressReport";
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
import { ErrorText } from "../ui/error-text";
import { Field, Fieldset } from "../ui/field";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { RUN_STATUSES, RunDetail } from "../work/StepPage";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { actorName } from "../work/workLogic";
import { EMPTY_DRAFT, settingsFromDraft, type DraftState } from "./automationsSettings.logic";

const automationList = apiWatch("automations.watch", { idleTtlMs: 0 })(undefined);

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

export function AutomationsSettings() {
  const automationsQuery = useApiQuery(automationList);
  const automations = automationsQuery.data;
  const [editor, setEditor] = useState<{ automation: Automation | null } | null>(null);
  // Null shows every automation's runs; an archived automation leaves the list, so all show again.
  const [selectedId, setSelectedId] = useState<AutomationId | null>(null);
  const selected = automations?.find(({ id }) => id === selectedId) ?? null;
  const shown = selected === null ? (automations ?? []) : [selected];
  const runs = shown
    .flatMap((automation) =>
      automation.runs.map((run) => ({ run, automation, number: runNumber(automation, run) })),
    )
    .toSorted(
      (a, b) => DateTime.toEpochMillis(b.run.startedAt) - DateTime.toEpochMillis(a.run.startedAt),
    );
  return (
    <div className="flex min-h-0 flex-1 flex-wrap overflow-y-auto">
      <nav
        aria-label="Automations"
        className="flex shrink-0 grow basis-60 flex-col gap-1 border-e px-3 py-4"
      >
        <AutomationNavButton isCurrent={selected === null} onSelect={() => setSelectedId(null)}>
          <CirclePlayIcon aria-hidden className="size-4 shrink-0" />
          All automations
        </AutomationNavButton>
        <h2 className="mt-3 px-2 text-xs leading-6 font-medium text-muted-foreground">
          Automations
        </h2>
        {(automations ?? []).map((automation) => (
          <AutomationNavButton
            key={automation.id}
            isCurrent={automation.id === selected?.id}
            onSelect={() => setSelectedId(automation.id)}
          >
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-info/8 text-info-foreground"
            >
              <BotIcon className="size-3" />
            </span>
            <span className="min-w-0">{automation.title}</span>
          </AutomationNavButton>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => setEditor({ automation: null })}
        >
          <PlusIcon aria-hidden />
          New automation
        </Button>
      </nav>
      <div className="min-w-0 shrink grow-[999] basis-120 p-6">
        <div className="mb-4 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-2xl font-semibold tracking-tight">
              {selected?.title ?? "All automations"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {selected === null
                ? "Showing runs from all automations"
                : "Showing runs from this automation"}
            </p>
          </div>
          {selected !== null && (
            <AutomationActions
              automation={selected}
              onEdit={() => setEditor({ automation: selected })}
              onArchived={automationsQuery.refresh}
            />
          )}
        </div>
        {automationsQuery.error ? (
          <ErrorText text={automationsQuery.error} />
        ) : !automations ? (
          <p className="text-sm text-muted-foreground">Loading automations…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <section aria-label="Runs" className="overflow-hidden rounded-xl border bg-card">
            <h3 className="bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground">
              {runs.length === 1 ? "1 run" : `${runs.length} runs`}
            </h3>
            <ol>
              {runs.map(({ run, automation, number }) => (
                <AutomationRunRow
                  key={run.chatId}
                  run={run}
                  automation={automation}
                  number={number}
                />
              ))}
            </ol>
          </section>
        )}
      </div>
      {editor ? (
        <AutomationEditorDialog
          automation={editor.automation}
          onSaved={automationsQuery.refresh}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

/** Runs are numbered from the automation's first on the same step, as the run's page is. */
function runNumber(automation: AutomationSummary, run: AutomationRun) {
  const sameStep = automation.runs.filter(({ stepId }) => stepId === run.stepId);
  return sameStep.length - sameStep.indexOf(run);
}

function AutomationNavButton({
  isCurrent,
  onSelect,
  children,
}: {
  readonly isCurrent: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={isCurrent || undefined}
      onClick={onSelect}
      className={`flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-start text-sm ${
        isCurrent
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/** Runs `work` once at a time, reporting its failure under `title`. */
function useAction() {
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
    }
  };
  return { busy, act };
}

/** The list streams run changes only, so changing an automation refreshes it. */
function AutomationActions({
  automation,
  onEdit,
  onArchived,
}: {
  readonly automation: AutomationSummary;
  readonly onEdit: () => void;
  readonly onArchived: () => void;
}) {
  const { busy, act } = useAction();
  return (
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
        <MenuItem
          onClick={() =>
            void act("Could not run automation", () =>
              api("automations.runNow", { id: automation.id }),
            )
          }
        >
          <PlayIcon />
          Run now
        </MenuItem>
        <MenuItem
          variant="destructive"
          onClick={() =>
            void act("Could not archive automation", async () => {
              await api("automations.archive", { id: automation.id });
              onArchived();
            })
          }
        >
          <ArchiveIcon />
          Archive for good
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * One run: how it stands, who started it, and what it reported. A run on a step names its ticket
 * and offers what the step offers its viewer; a step the viewer doesn't see shows neither.
 */
function AutomationRunRow({
  run,
  automation,
  number,
}: {
  readonly run: AutomationRun;
  readonly automation: AutomationSummary;
  readonly number: number;
}) {
  const directory = useWorkDirectory();
  const now = useNowMinute();
  const { busy, act } = useAction();
  const { data: view } = useApiQuery(
    run.stepId === null ? null : stepViews({ stepId: run.stepId }),
  );
  const stepAutomation = view?.automations.find(({ id }) => id === automation.id) ?? null;
  const { label, Icon, tone } = RUN_STATUSES[run.status];
  const callOnStep = (tag: "workflows.runStepAutomation" | "workflows.stopStepAutomation") =>
    view &&
    void act(
      tag === "workflows.stopStepAutomation" ? "Could not stop run" : "Could not run automation",
      () => api(tag, { stepId: view.step.id, automationId: automation.id }),
    );
  const runAgain =
    run.stepId === null
      ? () =>
          void act("Could not run automation", () =>
            api("automations.runNow", { id: automation.id }),
          )
      : stepAutomation?.runLabel != null
        ? () => callOnStep("workflows.runStepAutomation")
        : null;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 border-t px-4 py-3 text-sm">
      <div className="flex min-w-0 shrink grow basis-70 flex-col gap-1">
        <p className="flex items-center gap-2">
          <span role="img" aria-label={label} className="flex size-4 shrink-0">
            <Icon aria-hidden className={`size-4 ${tone}`} />
          </span>
          <span className="min-w-0 font-semibold">{automation.title}</span>
        </p>
        <p className="pl-6 text-xs text-muted-foreground">
          {view ? (
            <Link
              to="/my-work/$stepId/runs/$chatId"
              params={{ stepId: view.step.id, chatId: run.chatId }}
              className="hover:text-foreground hover:underline"
            >
              #{number}
            </Link>
          ) : (
            `#${number}`
          )}{" "}
          · Manually run by {actorName(directory, run.ranBy)}
        </p>
        {run.status === "running" ? (
          <ProgressReport report={run.latestReport} isRunning />
        ) : (
          run.latestReport !== null && (
            <p className="pl-6 text-xs wrap-break-word">{run.latestReport.message}</p>
          )
        )}
      </div>
      <div className="flex min-w-0 shrink basis-45 pt-px">
        {view && (
          <Link
            to="/my-work/$stepId"
            params={{ stepId: view.step.id }}
            className="inline-flex h-5.5 max-w-full items-center truncate rounded-full bg-info/8 px-2 text-xs font-medium text-info-foreground hover:underline"
          >
            {view.ticket.title}
          </Link>
        )}
      </div>
      <div className="flex shrink-0 basis-30 flex-col gap-1 pt-0.5 text-xs text-muted-foreground">
        <RunDetail Icon={CalendarIcon}>{formatRelativeTimeLabel(run.startedAt, now)}</RunDetail>
        <RunDetail Icon={TimerIcon}>
          {run.endedAt === null ? "In progress" : formatDurationLabel(run.startedAt, run.endedAt)}
        </RunDetail>
      </div>
      <div className="flex shrink-0 basis-16 justify-end">
        {run.status === "running"
          ? stepAutomation?.canStop && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => callOnStep("workflows.stopStepAutomation")}
              >
                <SquareIcon aria-hidden className="size-2.5 fill-current" />
                Stop
              </Button>
            )
          : runAgain !== null && (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Options for ${automation.title} run ${number}`}
                    />
                  }
                >
                  <MoreHorizontalIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={runAgain}>
                    <PlayIcon />
                    Run again
                  </MenuItem>
                </MenuPopup>
              </Menu>
            )}
      </div>
    </li>
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
