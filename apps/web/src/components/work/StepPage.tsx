import type { AutomationId } from "@t45/contracts/models/Automation";
import { StringId } from "@t45/contracts/models/primitives";
import type { StepNameView, StepView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  InfoIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlayIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { api, runtime } from "../../rpc/api";
import { appAtomRegistry } from "../../state/atomRegistry";
import { stepAutomationList } from "../../state/agents";
import { apiWatch, useApiQuery } from "../../state/rpc";
import { useIsAdmin } from "../../state/session";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { ErrorText } from "../ui/error-text";
import { ActorName } from "./ActorAvatar";
import { AssigneePicker } from "./AssigneePicker";
import { CardFold } from "./CardFold";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
  historyLabel,
  missingFields,
  type StepAct,
  type StepActions,
  stepActions,
} from "./workLogic";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { workChanged } from "../../state/work";

const isStepId = Schema.is(StringId);
const stepViews = apiWatch("workflows.watchStep", { idleTtlMs: 0 });

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
      <div className="flex gap-3 rounded-xl border border-info/32 bg-info/4 p-4">
        <InfoIcon aria-hidden className="mt-1 size-5 shrink-0 text-info" />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <StepHeading view={view} />
          {view.definition.instructions ? (
            <section aria-label="Goal">
              <p className="text-sm whitespace-pre-wrap">{view.definition.instructions}</p>
            </section>
          ) : null}
        </div>
      </div>
      {error && <ErrorText text={error} />}
      {missing.length > 0 || unfinished.length > 0 ? (
        <MissingRecap missing={missing} unfinished={unfinished} />
      ) : null}
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4">
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
      </div>
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
          <ItemDetails view={view} actions={actions} busy={busy} act={act} />
          <StepAutomations view={view} busy={busy} act={act} />
          <StepHistory view={view} />
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
        {view.history.map((entry, at) => (
          // oxlint-disable-next-line react/no-array-index-key -- The log only grows at its end.
          <li key={at} className="flex flex-col gap-0.5">
            <ActorName actor={entry.agentId ?? entry.userId} />
            <span className="text-xs text-muted-foreground">
              {historyLabel(entry.command)} · {formatRelativeTimeLabel(entry.createdAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </CardFold>
  );
}

/** The automations the workflow gives this step, each with its runs and the way to run or stop it. */
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
  const isAdmin = useIsAdmin();
  const now = useNowMinute();
  if (view.automations.length === 0) return null;
  const emptyCount = missingFields(view.fields).length;
  const call = (
    tag: "workflows.runStepAutomation" | "workflows.stopStepAutomation",
    automationId: AutomationId,
  ) => void act(() => api(tag, { stepId: view.step.id, automationId }));
  return (
    <CardFold as="aside" title="Automations">
      <div className="flex flex-col gap-3 text-sm">
        {titles.error && <ErrorText text={titles.error} />}
        {view.automations.map(({ id, runs, runLabel, canStop }) => {
          const status = runs[0]?.status;
          // A stopped run is over: the card offers a new one and lists it among the earlier.
          const state = status === undefined ? "notRun" : status === "stopped" ? "ready" : status;
          const latest = state === "ready" ? undefined : runs[0];
          const earlier = runs.slice(latest === undefined ? 0 : 1);
          const onAct =
            state === "running"
              ? canStop
                ? () => call("workflows.stopStepAutomation", id)
                : null
              : runLabel === null
                ? null
                : () => call("workflows.runStepAutomation", id);
          const title = (
            <>
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-info/12 text-info">
                <BotIcon aria-hidden className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {titles.data?.find((automation) => automation.id === id)?.title ??
                  "Unavailable automation"}
              </span>
            </>
          );
          return (
            <article key={id} className="flex flex-col gap-3 rounded-lg border p-3">
              {isAdmin ? (
                <Link to="/settings/automations" className="flex items-center gap-2">
                  {title}
                  <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </Link>
              ) : (
                <div className="flex items-center gap-2">{title}</div>
              )}
              {state === "ready" && onAct === null ? null : (
                <div className="flex flex-col gap-2 border-t pt-3">
                  {latest !== undefined && (
                    <div className="flex flex-col gap-0.5">
                      <ActorName actor={latest.ranBy} />
                      <span className="text-xs text-muted-foreground">
                        {state === "running" ? "started" : "ran"} this automation ·{" "}
                        {formatRelativeTimeLabel(latest.startedAt, now)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs">
                    <RunPill state={state} busy={busy} onAct={onAct} />
                    {state === "completed" && emptyCount > 0 ? (
                      <span className="min-w-0">
                        {emptyCount} {emptyCount === 1 ? "field" : "fields"} left empty
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
              {earlier.length > 0 && <EarlierRuns runs={earlier} now={now} />}
            </article>
          );
        })}
      </div>
    </CardFold>
  );
}

const play = <PlayIcon className="size-2.5 fill-current" />;
const RUN_PILLS = {
  notRun: {
    label: "Not run yet",
    action: "Run",
    tone: "border-border bg-muted text-foreground",
    dot: "bg-foreground text-background",
    act: play,
    still: <MinusIcon className="size-3" />,
  },
  running: {
    label: "Running",
    action: "Stop",
    tone: "border-info/32 bg-info/8 text-info-foreground",
    dot: "",
    act: null,
    still: null,
  },
  completed: {
    label: "Completed",
    action: "Run again",
    tone: "border-success/32 bg-success/8 text-success-foreground",
    dot: "bg-success-foreground text-white",
    act: play,
    still: <CheckIcon className="size-3" />,
  },
  failed: {
    label: "Failed",
    action: "Retry",
    tone: "border-destructive/32 bg-destructive/8 text-destructive-foreground",
    dot: "bg-destructive-foreground text-white",
    act: <RotateCwIcon className="size-3" />,
    still: <XIcon className="size-3" />,
  },
  ready: {
    label: "Run",
    action: "Run",
    tone: "border-border bg-muted text-foreground",
    dot: "bg-foreground text-background",
    act: play,
    still: null,
  },
} as const;

/**
 * How an automation's latest run stands, as a pill that also acts on it for whoever may: running
 * stops it, any other state runs the automation again. After a stop, it only offers a new run.
 */
function RunPill({
  state,
  busy,
  onAct,
}: {
  readonly state: keyof typeof RUN_PILLS;
  readonly busy: boolean;
  readonly onAct: (() => void) | null;
}) {
  const { label, action, tone, dot, act, still } = RUN_PILLS[state];
  const className = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-1 font-semibold ${tone}`;
  const content = (
    <>
      {state === "running" ? (
        <span aria-hidden className="grid size-5 shrink-0 place-items-center">
          <span className="col-start-1 row-start-1 size-5 animate-spin rounded-full border-2 border-info/24 border-t-info" />
          {onAct !== null && (
            <span className="col-start-1 row-start-1 size-2 rounded-xs bg-current" />
          )}
        </span>
      ) : (
        <span aria-hidden className={`grid size-5 shrink-0 place-items-center rounded-full ${dot}`}>
          {onAct === null ? still : act}
        </span>
      )}
      {label}
    </>
  );
  return onAct === null ? (
    <span className={className}>{content}</span>
  ) : (
    <button
      type="button"
      aria-label={label === action ? undefined : `${label}. ${action}`}
      disabled={busy}
      onClick={onAct}
      className={`${className} hover:brightness-95 disabled:opacity-64`}
    >
      {content}
    </button>
  );
}

const RUN_OUTCOMES = {
  running: { label: "Running", Icon: LoaderCircleIcon, tone: "text-info-foreground" },
  completed: { label: "Completed", Icon: CircleCheckIcon, tone: "text-success-foreground" },
  failed: { label: "Failed", Icon: CircleXIcon, tone: "text-destructive-foreground" },
  stopped: { label: "Stopped", Icon: CircleStopIcon, tone: "text-muted-foreground" },
} as const;

/** An automation's past runs, newest first, folded away at first. */
function EarlierRuns({
  runs,
  now,
}: {
  readonly runs: StepView["automations"][number]["runs"];
  readonly now: number;
}) {
  const directory = useWorkDirectory();
  return (
    <div className="border-t pt-3 text-xs">
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 font-medium text-muted-foreground">
          {runs.length} earlier {runs.length === 1 ? "run" : "runs"}
          <ChevronDownIcon
            aria-hidden
            className="size-3 transition-transform group-data-panel-open:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ol className="flex flex-col gap-2 pt-2">
            {runs.map((run) => {
              const { label, Icon, tone } = RUN_OUTCOMES[run.status];
              return (
                <li key={DateTime.formatIso(run.startedAt)} className="flex items-start gap-1.5">
                  <Icon aria-hidden className={`mt-px size-3.5 shrink-0 ${tone}`} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={`font-semibold ${tone}`}>{label}</span>
                    <span className="text-muted-foreground">
                      {actorName(directory, run.ranBy)} ·{" "}
                      {formatRelativeTimeLabel(run.startedAt, now)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </CollapsiblePanel>
      </Collapsible>
    </div>
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
 * The way back to the project's board, the item's title, and the step it is in when that isn't
 * the step on the page.
 */
function ItemHeader({ view }: { readonly view: StepView }) {
  const current =
    view.otherSteps.find(({ step }) => step.id !== view.step.id && step.status.type !== "completed")
      ?.name ?? null;
  return (
    <header className="flex flex-col gap-1">
      <div className="mb-5">
        <BackLink to="/boards/$slug" params={{ slug: view.ticket.projectId }}>
          {view.projectName}
        </BackLink>
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{view.ticket.title}</h2>
      {current !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">In {current}</Badge>
        </div>
      ) : null}
      {view.ticket.status.type === "cancelled" ? (
        <p className="mt-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Cancelled:</span> {view.ticket.status.reason}
        </p>
      ) : null}
    </header>
  );
}

/** The open step's name, the steps it sits in, and why it's blocked. */
function StepHeading({ view }: { readonly view: StepView }) {
  const { step } = view;
  return (
    <div className="flex flex-col gap-2">
      {view.parents.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {view.parents.map((parent, at) => (
            <span key={parent.id}>
              {at > 0 ? " › " : null}
              <Link
                to="/my-work/$stepId"
                params={{ stepId: parent.id }}
                className="hover:text-foreground hover:underline"
              >
                {parent.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <h2 className="text-lg font-semibold tracking-tight">{view.definition.name}</h2>
      {step.status.type === "blocked" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Blocked:</span> {step.status.reason}
        </p>
      ) : null}
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
