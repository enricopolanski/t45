import { useTranslation } from "~/i18n/locale";
import type { AutomationId } from "@t45/contracts/models/Automation";
import { AutomationSkipReason } from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";
import type { FieldView, StepNameView, StepView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import {
  CalendarIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleStopIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  TimerIcon,
  ZapIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { api, runtime } from "../../rpc/api";
import { appAtomRegistry } from "../../state/atomRegistry";
import { stepAutomationList } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { describeFailure } from "../../lib/failures";
import { cn } from "../../lib/utils";
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
import { ProposalReview } from "./ProposalReview";
import { RecordEntryReview } from "./RecordEntryReview";
import { attachStepFile, StepFields } from "./StepFields";
import { ConfirmedRecord, ReadOnlyStepFieldCard } from "./StepInputs";
import { StepStatus } from "./StepStatus";
import { StepSubSteps } from "./StepSubSteps";
import { useWorkDirectory } from "./useWorkDirectory";
import { BackLink, WorkFrame } from "./WorkFrame";
import {
  actorName,
  AUTOMATION_SKIP_REASONS,
  summarizeHistory,
  missingFields,
  type StepAct,
  type StepActions,
  stepActions,
} from "./workLogic";
import {
  formatChatTimestampTooltip,
  formatDurationLabel,
  formatRelativeTimeLabel,
} from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { stepViews, workChanged } from "../../state/work";

const isStepId = Schema.is(StringId);
const isAutomationSkipReason = Schema.is(AutomationSkipReason);

/**
 * An item, opened on one of its steps, like an issue: the item's title and details, what
 * earlier steps filled in, and the open step with its fields, sub-steps, comments, and the
 * actions open to the viewer. Keyed by step, so moving to another step starts fresh.
 */
export function StepPage({ stepId }: { readonly stepId: string }) {
  const t = useTranslation();
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
      <WorkFrame title={t("Item")}>
        {loadError !== null || !isStepId(stepId) ? (
          <ErrorText text={loadError ?? t("This step could not be found.")} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
        )}
      </WorkFrame>
    );
  }

  const actions = stepActions(view.ticket, view.step, view.canCancelTicket);
  const step = { stepId: view.step.id };
  const isHistorical = view.completedStep !== undefined;
  const writes = view.ticket.status.type === "open" && !isHistorical;
  const incomplete = view.subSteps.filter((step) => step.status.type !== "completed");
  const reviewFields = view.recordReviews.flatMap((review) => {
    const group = view.fields.find((field) => field.key === review.groupFieldId);
    return group === undefined ? [] : [{ group, review }];
  });
  const inputReviews = (view.inputRecordReviews ?? []).flatMap((review) => {
    const records = view.inputs[review.recordsIndex];
    const group = view.inputs[review.groupIndex];
    return records === undefined || group === undefined ? [] : [{ ...review, records, group }];
  });
  const completedReviews = reviewFields.flatMap(({ group, review }) => {
    const records = view.fields.find((field) => field.key === review.recordsFieldId);
    return records === undefined ? [] : [{ ...review, group, records }];
  });
  const fields = view.fields.filter((field) => {
    const subject = reviewFields.find(({ group }) => field.key === group.key);
    return (
      subject === undefined ||
      field.rows.some(
        ({ id }) =>
          !subject.review.entries.some(
            ({ rowId, hasDuplicateEntries }) => rowId === id && !hasDuplicateEntries,
          ),
      )
    );
  });
  const pendingReviews = view.fields.filter((field) =>
    view.recordReviews.some(
      (review) =>
        review.recordsFieldId === field.key &&
        review.entries.some(({ isConfirmed }) => !isConfirmed),
    ),
  );
  const empty = missingFields(fields);
  const missing = triedDone ? empty : [];
  const unfinished = triedDone ? incomplete : [];
  const unconfirmed = triedDone ? pendingReviews : [];
  const markDone = () => {
    setTriedDone(true);
    setError(null);
    if (empty.length === 0 && incomplete.length === 0 && pendingReviews.length === 0) {
      void act(async () => {
        await api("workflows.markStepDone", step);
        // Done, a step of the workflow leaves its members' sight: back to their work.
        if (view.parents.length === 0) await navigate({ to: "/my-work" });
      });
    }
  };
  // The workflow's step this one is, or sits in, shown among all the others.
  const rootId = view.parents[0]?.id ?? view.step.id;
  const recordStatus = (field: FieldView) => {
    const { collection } = field;
    const reviews = reviewFields.filter(({ review }) => review.recordsFieldId === field.key);
    if (collection === null || reviews.length === 0) return undefined;
    return (record: FieldView["records"][number]) => (
      <div className="flex flex-wrap gap-1">
        {reviews.map(({ group, review }) => {
          const entry = review.entries.find(({ recordKey }) => recordKey === record.key);
          if (entry === undefined) return null;
          if (entry.isConfirmed) return <ConfirmedRecord key={group.key} />;
          return isHistorical ? null : (
            <RecordEntryReview
              key={group.key}
              step={view.step}
              item={{ group, review, collection, entry, record }}
              act={act}
            />
          );
        })}
      </div>
    );
  };
  const open = (
    <section key="open" aria-label={t("Open step")} className="flex flex-col gap-4">
      {error && <ErrorText text={error} />}
      {missing.length > 0 || unfinished.length > 0 || unconfirmed.length > 0 ? (
        <MissingRecap missing={missing} unfinished={unfinished} unconfirmed={unconfirmed} />
      ) : null}
      <ItemDescription description={view.ticket.description} />
      <ReadOnlyStepFieldCard
        title={t("Inputs")}
        fields={view.inputs}
        reviews={inputReviews}
        defaultOpen={false}
      />
      <StepFiles
        view={view}
        canWrite={writes}
        busy={busy}
        onAttach={(files) =>
          void act(async () => {
            for (const file of files) await attachStepFile(view.step.id, file);
          })
        }
        onRemove={(attachmentId) =>
          void act(() => api("workflows.removeStepFile", { ...step, attachmentId }))
        }
      />
      {isHistorical ? (
        <ReadOnlyStepFieldCard
          title={t("Fields")}
          fields={view.fields}
          reviews={completedReviews}
          defaultOpen
        />
      ) : (
        <StepFields
          fields={actions.canEditFields ? fields : view.fields}
          editable={actions.canEditFields}
          missing={new Set(missing.map((field) => field.key))}
          holdOpen={unconfirmed.length > 0}
          onSave={(fieldKey, value) =>
            void act(() => api("workflows.setStepField", { ...step, fieldKey, value }))
          }
          onUpload={(fieldKey, file) =>
            void act(() => attachStepFile(view.step.id, file, fieldKey))
          }
          onRecordSaved={() => void act(() => Promise.resolve())}
          recordStatus={recordStatus}
          review={
            actions.canEditFields ? (
              <ProposalReview
                view={view}
                onReview={(proposal, isApproved) => {
                  const reviewed = { ...step, proposalId: proposal.id };
                  return act(
                    () =>
                      isApproved
                        ? api("workflows.approveProposal", reviewed)
                        : api("workflows.discardProposal", reviewed),
                    true,
                  );
                }}
              />
            ) : null
          }
        />
      )}
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
    <WorkFrame
      title={view.ticket.title}
      tabTitle={`${view.ticket.title} · ${view.definition.name}`}
      width="full"
      contentClassName="p-6"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <ItemHeader view={view} />
          <StepStepper view={view} rootId={rootId} />
          {isHistorical ? (
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
              <p>
                <span className="font-medium">{t("Read-only")}</span> {t("· Completed")}{" "}
                {formatChatTimestampTooltip(view.step.status.at)}
              </p>
              {view.completedStep === "legacy" ? (
                <p className="text-muted-foreground">
                  {t(
                    "This step was completed before snapshots were available. Linked records show current collection data.",
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            {(view.stepNavigation?.length ?? 0) > 1
              ? open
              : view.otherSteps.map((entry) =>
                  entry.step.id === rootId ? open : <OtherStep key={entry.step.id} view={entry} />,
                )}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <StepStatus view={view} actions={actions} busy={busy} act={act} onMarkDone={markDone} />
          {hasInstructions ? (
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTab value="overview">{t("Overview")}</TabsTab>
                <TabsTab value="instructions">{t("Instructions")}</TabsTab>
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

const stepNameParts = /^Step (\d+)\s+[—–-]\s+(.+)$/iu;
const stepperStatus = {
  completed: {
    label: "Completed",
    Icon: CheckIcon,
    marker: "border-success-foreground/25 bg-success text-success-foreground",
    text: "text-success-foreground",
  },
  working: {
    label: "In progress",
    Icon: CircleDotIcon,
    marker: "border-primary/60 bg-primary/10 text-primary",
    text: "text-primary",
  },
  blocked: {
    label: "Blocked",
    Icon: PauseIcon,
    marker: "border-warning-foreground/30 bg-warning text-warning-foreground",
    text: "text-warning-foreground",
  },
  cancelled: {
    label: "Cancelled",
    Icon: CircleIcon,
    marker: "border-border bg-muted text-muted-foreground",
    text: "text-muted-foreground",
  },
} as const;

function StepStepper({ view, rootId }: { readonly view: StepView; readonly rootId: string }) {
  const t = useTranslation();
  const steps = view.stepNavigation ?? [];
  if (steps.length === 0) return null;
  return (
    <nav aria-label={t("Item steps")} className="min-w-0 rounded-xl border border-border bg-card">
      <ol className="flex gap-2 overflow-x-auto rounded-xl p-2 sm:px-3">
        {steps.map(({ id, name, status }, index) => {
          const isSelected = id === rootId;
          const isCompleted = status === "completed";
          const label = stepNameParts.exec(name);
          const appearance =
            stepperStatus[
              !isCompleted && view.ticket.status.type === "cancelled" ? "cancelled" : status
            ];
          return (
            <li key={id} className="relative flex min-w-32 flex-1">
              <Link
                to="/my-work/$stepId"
                params={{ stepId: id }}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-start gap-2 rounded-lg p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isSelected && "bg-accent/80 ring-1 ring-border ring-inset",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border",
                    appearance.marker,
                  )}
                >
                  <appearance.Icon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  {label === null ? null : (
                    <span className="text-xs text-muted-foreground">{t("Step {0}", label[1])}</span>
                  )}
                  <span className="text-sm leading-snug font-medium wrap-anywhere">
                    {label?.[2] ?? name}
                  </span>
                  <span className={cn("text-xs font-medium", appearance.text)}>
                    {t(appearance.label)}
                  </span>
                </span>
              </Link>
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute top-6 -right-2 left-12 h-px bg-border",
                    isCompleted && "bg-success-foreground/50",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** What was done on the step, oldest first: who or which agent, what, and when. */
function StepHistory({ view }: { readonly view: StepView }) {
  const t = useTranslation();
  const now = useNowMinute();
  if (view.history.length === 0) return null;
  return (
    <CardFold as="aside" title={t("History")}>
      <ol className="flex flex-col gap-2 text-sm">
        {summarizeHistory(view.history, t).map((entry, at) => (
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
  const t = useTranslation();
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
  // Entering the step tried them, so they are older than its runs.
  const skipped = view.step.skippedAutomations ?? [];
  if (runs.length === 0 && skipped.length === 0 && runnable.length === 0) return null;
  const titleOf = (id: AutomationId) =>
    titles.data?.find((automation) => automation.id === id)?.title ?? t("Unavailable automation");
  const call = (
    tag: "workflows.runStepAutomation" | "workflows.stopStepAutomation",
    automationId: AutomationId,
  ) => void act(() => api(tag, { stepId: view.step.id, automationId }));
  const runningCount = runs.filter(({ status }) => status === "running").length;
  return (
    <aside aria-label={t("Automations")} className="card flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ZapIcon aria-hidden className="size-4" />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("Automations")}</h2>
        {runningCount > 0 && (
          <Badge variant="info">
            {runningCount} {t("running")}
          </Badge>
        )}
      </div>
      {titles.error && <ErrorText text={titles.error} />}
      {runs.length === 0 && skipped.length === 0 ? (
        <p className="text-muted-foreground">{t("No automation has run on this item yet.")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {runs.map(({ automation, number, ...run }) => {
            const { label, Icon, tone } = RUN_STATUSES[run.status];
            return (
              <li
                key={`${automation.id}-${number}`}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3",
                  run.status === "running" && "border-info/24 bg-info/6",
                )}
              >
                <div className="flex min-h-6 items-center gap-2">
                  <span role="img" aria-label={t(label)} className="flex size-4 shrink-0">
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
                          {t("Stop")}
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
                                aria-label={t("Options for run {0}", number)}
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
                              {t("Run again")}
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
                    {run.isAutomatic ? t("· Automatically run for") : t("· Manually run by")}{" "}
                    {actorName(directory, run.ranBy)}
                  </p>
                  {run.status !== "running" && run.latestReport !== null && (
                    <p className="pl-6 wrap-break-word text-foreground">
                      {run.latestReport.message}
                    </p>
                  )}
                  <RunDetail Icon={CalendarIcon}>
                    {formatRelativeTimeLabel(run.startedAt, now)}
                  </RunDetail>
                  {run.endedAt === null ? (
                    <Badge variant="info" className="ms-6 self-start">
                      {t("In progress")}
                    </Badge>
                  ) : (
                    <RunDetail Icon={TimerIcon}>
                      {formatDurationLabel(run.startedAt, run.endedAt)}
                    </RunDetail>
                  )}
                  {run.status === "running" && (
                    <ProgressReport report={run.latestReport} isRunning />
                  )}
                </div>
              </li>
            );
          })}
          {skipped.map((entry) => (
            <li
              key={`${entry.automationId}-skipped`}
              className="flex flex-col gap-1 rounded-lg border p-3"
            >
              <div className="flex min-h-6 items-center gap-2">
                <span role="img" aria-label={t("Not started")} className="flex size-4 shrink-0">
                  <CircleXIcon aria-hidden className="size-4 text-destructive-foreground" />
                </span>
                <span className="min-w-0 flex-1 font-semibold">{titleOf(entry.automationId)}</span>
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <p className="pl-6">{t("Didn't start automatically on step entry")}</p>
                <p className="pl-6 wrap-break-word text-foreground">
                  {isAutomationSkipReason(entry.reason)
                    ? t(AUTOMATION_SKIP_REASONS[entry.reason])
                    : entry.reason}
                </p>
                <RunDetail Icon={CalendarIcon}>{formatRelativeTimeLabel(entry.at, now)}</RunDetail>
              </div>
            </li>
          ))}
        </ol>
      )}
      {runnable.length > 0 && (
        <RunAutomation
          automations={runnable.map(({ id }) => ({ id, title: titleOf(id) }))}
          busy={busy}
          onRun={(id) => call("workflows.runStepAutomation", id)}
        />
      )}
    </aside>
  );
}

export function RunDetail({
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
  const t = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [chosen, setChosen] = useState<AutomationId | null>(null);
  const selected = automations.find(({ id }) => id === chosen) ?? automations[0];
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger render={<Button className="w-full" />}>
        <PlayIcon aria-hidden className="fill-current" />
        {t("Run Automation")}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <div className="flex flex-col gap-3">
          <Field label={t("Automation")}>
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
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setIsOpen(false);
                if (selected !== undefined) onRun(selected.id);
              }}
            >
              {t("Run automation")}
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
  unconfirmed,
}: {
  readonly missing: ReturnType<typeof missingFields>;
  readonly unfinished: ReadonlyArray<StepNameView>;
  readonly unconfirmed: StepView["fields"];
}) {
  const t = useTranslation();
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
      <p className="font-medium">{t("To mark this step done:")}</p>
      <ul className="flex flex-col gap-0.5">
        {missing.map((field) => (
          <li key={field.key}>
            <button
              type="button"
              className="text-left text-destructive hover:underline"
              onClick={() => reveal(field.key)}
            >
              {t("Fill in")} {field.name}
            </button>
          </li>
        ))}
        {unconfirmed.map((field) => (
          <li key={`review-${field.key}`}>
            <button
              type="button"
              className="text-left text-destructive hover:underline"
              onClick={() => reveal(field.key)}
            >
              {t("Confirm reviews for")} {field.label}
            </button>
          </li>
        ))}
        {unfinished.map((subStep) => (
          <li key={subStep.id} className="text-destructive">
            {t("Finish")} {subStep.name}
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
  const t = useTranslation();
  const { step } = view;
  const hasStepper = (view.stepNavigation?.length ?? 0) > 0;
  const current =
    view.otherSteps.find(
      ({ step: other }) => other.id !== step.id && other.status.type !== "completed",
    )?.name ?? null;
  return (
    <header className="flex flex-col gap-2">
      <BackLink to="/boards/$slug" params={{ slug: view.ticket.projectId }}>
        {view.projectName}
      </BackLink>
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight wrap-anywhere">{view.ticket.title}</h2>
        {!hasStepper || view.parents.length > 0 ? (
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
        ) : null}
      </div>
      {!hasStepper && current !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {t("In")} {current}
          </Badge>
        </div>
      ) : null}
      {view.ticket.status.type === "cancelled" && view.ticket.status.reason !== undefined ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">{t("Cancelled:")}</span> {view.ticket.status.reason}
        </p>
      ) : null}
      {step.status.type === "blocked" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">{t("Blocked:")}</span> {step.status.reason}
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
  const t = useTranslation();
  const { step, ticket: item } = view;
  return (
    <CardFold as="aside" title={t("Details")}>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("Assignee")}</dt>
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
        <dt className="text-muted-foreground">{t("Project")}</dt>
        <dd className="min-w-0 truncate">
          <Link to="/boards/$slug" params={{ slug: item.projectId }} className="hover:underline">
            {view.projectName}
          </Link>
        </dd>
      </dl>
    </CardFold>
  );
}
