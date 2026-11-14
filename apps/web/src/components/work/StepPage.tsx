import type { AutomationId } from "@t45/contracts/models/Automation";
import { StringId } from "@t45/contracts/models/primitives";
import type { StepNameView, StepView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import {
  CalendarIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MoreHorizontalIcon,
  PlayIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { api, runtime } from "../../rpc/api";
import { appAtomRegistry } from "../../state/atomRegistry";
import { stepAutomationList } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ErrorText } from "../ui/error-text";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { ProgressReport } from "../ProgressReport";
import { ActorName } from "./ActorAvatar";
import { AssigneePicker } from "./AssigneePicker";
import { CardFold } from "./CardFold";
import { OtherStep } from "./ItemSteps";
import { ItemDescription } from "./ItemDescription";
import { StepComments, StepFiles } from "./StepConversation";
import { attachStepFile, ReadOnlyFields, StepFields } from "./StepFields";
import { StepStatus } from "./StepStatus";
import { StepSubSteps } from "./StepSubSteps";
import { useWorkDirectory } from "./useWorkDirectory";
import { BackLink, WorkFrame } from "./WorkFrame";
import {
  actorName,
  summarizeHistory,
  missingFields,
  type StepAct,
  type StepActions,
  stepActions,
} from "./workLogic";
import { formatDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { stepViews, workChanged } from "../../state/work";

const isStepId = Schema.is(StringId);

/**
 * An item, opened on one of its steps, like an issue: the item's title and details, what
 * earlier steps filled in, and the open step with its fields, sub-steps, comments, and the
 * actions open to the viewer. Keyed by step, so moving to another step starts fresh.
 */
export function StepPage({ stepId }: { readonly stepId: string }) {
  const stepView = isStepId(stepId) ? stepViews({ stepId }) : null;
  const { data: view, error: loadError, refresh } = useApiQuery(stepView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once Mark done is tried; from then on, what's missing shows and clears as it's filled.
  const [triedDone, setTriedDone] = useState(false);
  const navigate = useNavigate();

  const act: StepAct = async (run, quiet = false) => {
    setBusy(true);
    if (!quiet) setError(null);
    try {
      await run();
      workChanged();
      if (stepView !== null) {
        const previous = appAtomRegistry.get(stepView);
        refresh();
        await runtime.runPromise(
          AtomRegistry.toStream(appAtomRegistry, stepView).pipe(
            Stream.filter((result) =>
              result._tag === "Success"
                ? previous._tag !== "Success" || result.value !== previous.value
                : result._tag === "Failure" && !result.waiting,
            ),
            Stream.take(1),
            Stream.runDrain,
          ),
        );
      }
      return null;
    } catch (cause) {
      const message = describeFailure(cause);
      if (!quiet) setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  if (view === null || loadError !== null) {
    return (
      <WorkFrame title="Item">
        {loadError !== null || !isStepId(stepId) ? (
          <ErrorText text={loadError ?? "This step could not be found."} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </WorkFrame>
    );
  }

  const actions = stepActions(view.ticket, view.step, view.canCancelTicket);
  const step = { stepId: view.step.id };
  const writes = view.ticket.status.type === "open";
  const incomplete = view.subSteps.filter((step) => step.status.type !== "completed");
  const empty = missingFields(view.fields);
  const missing = triedDone ? empty : [];
  const unfinished = triedDone ? incomplete : [];
  const markDone = () => {
    setTriedDone(true);
    setError(null);
    if (empty.length === 0 && incomplete.length === 0) {
      void act(async () => {
        await api("workflows.markStepDone", step);
        // Done, a step of the workflow leaves its members' sight: back to their work.
        if (view.parents.length === 0) await navigate({ to: "/my-work" });
      });
    }
  };
  // The workflow's step this one is, or sits in, shown among all the others.
  const rootId = view.parents[0]?.id ?? view.step.id;
  const open = (
    <section key="open" aria-label="Open step" className="flex flex-col gap-6">
      {error && <ErrorText text={error} />}
      {missing.length > 0 || unfinished.length > 0 ? (
        <MissingRecap missing={missing} unfinished={unfinished} />
      ) : null}
      <ItemDescription description={view.ticket.description} />
      <StepFiles
        view={view}
        canWrite={writes}
        busy={busy}
        onAttach={(file) => void act(() => attachStepFile(view.step.id, file))}
        onRemove={(attachmentId) =>
          void act(() => api("workflows.removeStepFile", { ...step, attachmentId }))
        }
      />
      {view.inputs.length > 0 ? (
        <section aria-label="Inputs" className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">Inputs</h2>
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <ReadOnlyFields fields={view.inputs} />
          </div>
        </section>
      ) : null}
      <StepFields
        fields={view.fields}
        editable={actions.canEditFields}
        missing={new Set(missing.map((field) => field.key))}
        onSave={(fieldKey, value) =>
          void act(() => api("workflows.setStepField", { ...step, fieldKey, value }))
        }
        onUpload={(fieldKey, file) => void act(() => attachStepFile(view.step.id, file, fieldKey))}
      />
      <StepSubSteps view={view} />
      <StepComments
        view={view}
        canWrite={writes}
        busy={busy}
        onComment={async (body) =>
          (await act(() => api("workflows.commentOnStep", { ...step, body }))) === null
        }
      />
    </section>
  );
  const hasInstructions = view.definition.instructions !== "";
  const overview = (
    <>
      <ItemDetails view={view} actions={actions} busy={busy} act={act} />
      <StepAutomations view={view} busy={busy} act={act} />
      <StepHistory view={view} />
    </>
  );
  return (
    <WorkFrame title={view.ticket.title} width="split">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <ItemHeader view={view} />
          <div className="flex flex-col gap-3">
            {view.otherSteps.map((entry) =>
              entry.step.id === rootId ? open : <OtherStep key={entry.step.id} view={entry} />,
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <StepStatus view={view} actions={actions} busy={busy} act={act} onMarkDone={markDone} />
          {hasInstructions ? (
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTab value="overview">Overview</TabsTab>
                <TabsTab value="instructions">Instructions</TabsTab>
              </TabsList>
              <TabsPanel value="overview">
                <div className="flex flex-col gap-3">{overview}</div>
              </TabsPanel>
              <TabsPanel value="instructions">
                <StepInstructions view={view} />
              </TabsPanel>
            </Tabs>
          ) : (
            overview
          )}
        </div>
      </div>
    </WorkFrame>
  );
}

/** What was done on the step, oldest first: who or which agent, what, and when. */
function StepHistory({ view }: { readonly view: StepView }) {
  const now = useNowMinute();
  if (view.history.length === 0) return null;
  return (
    <CardFold as="aside" title="History">
      <ol className="flex flex-col gap-2 text-sm">
        {summarizeHistory(view.history).map((entry, at) => (
          // oxlint-disable-next-line react/no-array-index-key -- The log only grows at its end.
          <li key={at} className="flex flex-col gap-0.5">
            <ActorName actor={entry.agentId ?? entry.userId} />
            <span className="text-xs text-muted-foreground">
              {entry.label} · {formatRelativeTimeLabel(entry.createdAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </CardFold>
  );
}

export const RUN_STATUSES = {
  running: { label: "Running", Icon: LoaderCircleIcon, tone: "animate-spin text-info" },
  completed: { label: "Completed", Icon: CircleCheckIcon, tone: "text-success-foreground" },
  failed: { label: "Failed", Icon: CircleXIcon, tone: "text-destructive-foreground" },
  stopped: { label: "Stopped", Icon: CircleStopIcon, tone: "text-muted-foreground" },
} as const;

/** The runs of the automations the workflow gives this step, newest first, and the way to start one. */
function StepAutomations({
  view,
  busy,
  act,
}: {
  readonly view: StepView;
  readonly busy: boolean;
  readonly act: StepAct;
}) {
  const titles = useApiQuery(stepAutomationList);
  const directory = useWorkDirectory();
  const now = useNowMinute();
  const runnable = view.automations.filter((automation) => automation.runLabel !== null);
  const runs = view.automations
    .flatMap((automation) =>
      automation.runs.map((run, at) => ({
        ...run,
        automation,
        number: automation.runs.length - at,
      })),
    )
    .toSorted((a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt));
  if (runs.length === 0 && runnable.length === 0) return null;
  const titleOf = (id: AutomationId) =>
    titles.data?.find((automation) => automation.id === id)?.title ?? "Unavailable automation";
  const call = (
    tag: "workflows.runStepAutomation" | "workflows.stopStepAutomation",
    automationId: AutomationId,
  ) => void act(() => api(tag, { stepId: view.step.id, automationId }));
  return (
    <aside aria-label="Automations" className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 font-medium">Automations</h2>
        {runnable.length > 0 && (
          <RunAutomation
            automations={runnable.map(({ id }) => ({ id, title: titleOf(id) }))}
            busy={busy}
            onRun={(id) => call("workflows.runStepAutomation", id)}
          />
        )}
      </div>
      {titles.error && <ErrorText text={titles.error} />}
      {runs.length > 0 && (
        <ol className="overflow-hidden rounded-xl border bg-card">
          {runs.map(({ automation, number, ...run }) => {
            const { label, Icon, tone } = RUN_STATUSES[run.status];
            return (
              <li
                key={`${automation.id}-${number}`}
                className="flex flex-col gap-1 border-t p-3 first:border-t-0"
              >
                <div className="flex min-h-6 items-center gap-2">
                  <span role="img" aria-label={label} className="flex size-4 shrink-0">
                    <Icon aria-hidden className={`size-4 ${tone}`} />
                  </span>
                  <span className="min-w-0 flex-1 font-semibold">{titleOf(automation.id)}</span>
                  {run.status === "running"
                    ? automation.canStop && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => call("workflows.stopStepAutomation", automation.id)}
                        >
                          <SquareIcon aria-hidden className="size-2.5 fill-current" />
                          Stop
                        </Button>
                      )
                    : automation.runLabel !== null && (
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Options for run ${number}`}
                              />
                            }
                          >
                            <MoreHorizontalIcon aria-hidden />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem
                              onClick={() => call("workflows.runStepAutomation", automation.id)}
                            >
                              <PlayIcon />
                              Run again
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      )}
                </div>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p className="pl-6">
                    <Link
                      to="/my-work/$stepId/runs/$chatId"
                      params={{ stepId: view.step.id, chatId: run.chatId }}
                      className="hover:text-foreground hover:underline"
                    >
                      #{number}
                    </Link>{" "}
                    · Manually run by {actorName(directory, run.ranBy)}
                  </p>
                  {run.status !== "running" && run.latestReport !== null && (
                    <p className="pl-6 wrap-break-word text-foreground">
                      {run.latestReport.message}
                    </p>
                  )}
                  <RunDetail Icon={CalendarIcon}>
                    {formatRelativeTimeLabel(run.startedAt, now)}
                  </RunDetail>
                  <RunDetail Icon={TimerIcon}>
                    {run.endedAt === null
                      ? "In progress"
                      : formatDurationLabel(run.startedAt, run.endedAt)}
                  </RunDetail>
                  {run.status === "running" && (
                    <ProgressReport report={run.latestReport} isRunning />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function RunDetail({
  Icon,
  children,
}: {
  readonly Icon: LucideIcon;
  readonly children: ReactNode;
}) {
  return (
    <p className="flex items-center gap-2">
      <span aria-hidden className="flex w-4 shrink-0 justify-center">
        <Icon className="size-3" />
      </span>
      {children}
    </p>
  );
}

/** Starts one of the step's automations, chosen in a popover. */
function RunAutomation({
  automations,
  busy,
  onRun,
}: {
  readonly automations: ReadonlyArray<{ readonly id: AutomationId; readonly title: string }>;
  readonly busy: boolean;
  readonly onRun: (automationId: AutomationId) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [chosen, setChosen] = useState<AutomationId | null>(null);
  const selected = automations.find(({ id }) => id === chosen) ?? automations[0];
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger render={<Button size="sm" />}>Run Automation</PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <div className="flex flex-col gap-3">
          <Field label="Automation">
            <Select
              value={selected?.id ?? null}
              onValueChange={(value) =>
                setChosen(automations.find(({ id }) => id === value)?.id ?? null)
              }
            >
              <SelectTrigger size="sm">
                <SelectValue>{selected?.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {automations.map(({ id, title }) => (
                  <SelectItem key={id} value={id}>
                    {title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setIsOpen(false);
                if (selected !== undefined) onRun(selected.id);
              }}
            >
              Run automation
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * What still stops the step from being marked done: each empty field, which scrolls to it, and
 * each unfinished sub-step.
 */
function MissingRecap({
  missing,
  unfinished,
}: {
  readonly missing: ReturnType<typeof missingFields>;
  readonly unfinished: ReadonlyArray<StepNameView>;
}) {
  const reveal = (key: string) => {
    const target = document.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(key)}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.querySelector<HTMLElement>("input:not([hidden]), textarea, button")?.focus();
  };
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-lg border border-destructive/36 px-3 py-2 text-sm"
    >
      <p className="font-medium">To mark this step done:</p>
      <ul className="flex flex-col gap-0.5">
        {missing.map((field) => (
          <li key={field.key}>
            <button
              type="button"
              className="text-left text-destructive hover:underline"
              onClick={() => reveal(field.key)}
            >
              Fill in {field.name}
            </button>
          </li>
        ))}
        {unfinished.map((subStep) => (
          <li key={subStep.id} className="text-destructive">
            Finish {subStep.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The way back to the project's board, the item's title, and under it the open step with the steps
 * it sits in and the way to its instructions. Then the step the item is in when that isn't the step
 * on the page, and why the item was cancelled or the step blocked.
 */
function ItemHeader({ view }: { readonly view: StepView }) {
  const { step } = view;
  const current =
    view.otherSteps.find(
      ({ step: other }) => other.id !== step.id && other.status.type !== "completed",
    )?.name ?? null;
  return (
    <header className="flex flex-col gap-3">
      <BackLink to="/boards/$slug" params={{ slug: view.ticket.projectId }}>
        {view.projectName}
      </BackLink>
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-semibold tracking-tight">{view.ticket.title}</h2>
        <h3 className="text-sm text-muted-foreground">
          {view.parents.map((parent) => (
            <Fragment key={parent.id}>
              <Link
                to="/my-work/$stepId"
                params={{ stepId: parent.id }}
                className="hover:text-foreground hover:underline"
              >
                {parent.name}
              </Link>
              {" › "}
            </Fragment>
          ))}
          {view.definition.name}
        </h3>
      </div>
      {current !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">In {current}</Badge>
        </div>
      ) : null}
      {view.ticket.status.type === "cancelled" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Cancelled:</span> {view.ticket.status.reason}
        </p>
      ) : null}
      {step.status.type === "blocked" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Blocked:</span> {step.status.reason}
        </p>
      ) : null}
    </header>
  );
}

/** The open step's instructions, under its name. */
function StepInstructions({ view }: { readonly view: StepView }) {
  return (
    <div className="card flex flex-col gap-3 p-4">
      <h2 className="text-base font-medium">{view.definition.name}</h2>
      <p className="text-sm whitespace-pre-wrap text-foreground/80">
        {view.definition.instructions}
      </p>
    </div>
  );
}

/**
 * The Details card, collapsible like a ticket's: who has the open step and the item's project.
 * Cancelling is on the status.
 */
function ItemDetails({
  view,
  actions,
  busy,
  act,
}: {
  readonly view: StepView;
  readonly actions: StepActions;
  readonly busy: boolean;
  readonly act: StepAct;
}) {
  const { step, ticket: item } = view;
  return (
    <CardFold as="aside" title="Details">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="min-w-0">
          {actions.canSetAssignee ? (
            <AssigneePicker
              current={step.assignee}
              memberIds={view.assignableUserIds}
              disabled={busy}
              onPick={(assignee) =>
                void act(() =>
                  api("workflows.setStepAssignee", {
                    stepId: step.id,
                    assignee,
                  }),
                )
              }
            />
          ) : (
            <ActorName actor={step.assignee} />
          )}
        </dd>
        <dt className="text-muted-foreground">Project</dt>
        <dd className="min-w-0 truncate">
          <Link to="/boards/$slug" params={{ slug: item.projectId }} className="hover:underline">
            {view.projectName}
          </Link>
        </dd>
      </dl>
    </CardFold>
  );
}
