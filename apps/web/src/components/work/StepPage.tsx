import { StepAutomationsEditor } from "./StepAutomationsEditor";
import { StringId } from "@t45/contracts/models/primitives";
import { NotFound } from "@t45/contracts/resources/errors";
import type { StepNameView, StepView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { InfoIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { SavedInput } from "../SavedInput";
import { ActorName } from "./ActorAvatar";
import { AssigneePicker } from "./AssigneePicker";
import { CardFold } from "./CardFold";
import { OtherStep } from "./ItemSteps";
import { ItemDescription } from "./ItemDescription";
import { StepComments, StepFiles } from "./StepConversation";
import { attachStepFile, StepFields } from "./StepFields";
import { StepStatus } from "./StepStatus";
import { StepSubSteps } from "./StepSubSteps";
import { BackLink, WorkFrame } from "./WorkFrame";
import { useSession } from "../../state/session";
import {
  missingFields,
  type StepAct,
  type StepActions,
  stepActions,
  stepNameOf,
} from "./workLogic";
import { workChanged } from "../../state/work";

type StepData =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly view: StepView;
    }
  | { readonly status: "failed"; readonly message: string };

const isStepId = Schema.is(StringId);

/**
 * An item, opened on one of its steps, like an issue: the item's title and details, what
 * earlier steps filled in, and the open step with its fields, sub-steps, comments, and the
 * actions open to the viewer. Opening it reads the step's notifications. Keyed by step, so moving to another step
 * starts fresh.
 */
export function StepPage({ stepId }: { readonly stepId: string }) {
  const [data, setData] = useState<StepData>({ status: "loading" });
  const viewerUserId = useSession()?.userId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once Mark done is tried; from then on, what's missing shows and clears as it's filled.
  const [triedDone, setTriedDone] = useState(false);

  const load = useCallback(() => {
    const step = { stepId };
    return (
      isStepId(stepId) ? api("workflows.getStep", step) : Promise.reject(new NotFound())
    ).then(
      (view) => {
        setData({ status: "ready", view });
        // Opening the step read its notifications.
        workChanged();
      },
      (cause: unknown) => {
        setData({ status: "failed", message: describeFailure(cause) });
      },
    );
  }, [stepId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act: StepAct = async (run, quiet = false) => {
    setBusy(true);
    if (!quiet) setError(null);
    try {
      await run();
      await load();
      return null;
    } catch (cause) {
      const message = describeFailure(cause);
      if (!quiet) setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  if (data.status !== "ready") {
    return (
      <WorkFrame title="Item">
        {data.status === "failed" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {data.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </WorkFrame>
    );
  }

  const { view } = data;
  const actions = stepActions(view.ticket, view.step, viewerUserId);
  const step = { stepId: view.step.id };
  const writes = view.ticket.status.type === "open";
  const unpassed = view.subSteps.filter((step) => step.status.type !== "completed");
  const empty = missingFields(view.fields);
  const missing = triedDone ? empty : [];
  const unapproved = triedDone ? unpassed : [];
  const markDone = () => {
    setTriedDone(true);
    setError(null);
    if (empty.length === 0 && unpassed.length === 0) {
      void act(() => api("workflows.markStepDone", step));
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
          {view.definition?.instructions ? (
            <section aria-label="Goal">
              <p className="text-sm whitespace-pre-wrap">{view.definition.instructions}</p>
            </section>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {missing.length > 0 || unapproved.length > 0 ? (
        <MissingRecap missing={missing} unapproved={unapproved} />
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
          <AgentCard view={view} actions={actions} busy={busy} act={act} />
        </div>
      </div>
    </WorkFrame>
  );
}

function AgentCard({
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
  return (
    <CardFold as="aside" title="Automations">
      {view.tasks.map((task) => (
        <div key={task.chatId} className="flex flex-col gap-1 text-sm">
          <Link
            to="/chats/$chatId"
            params={{ chatId: task.chatId }}
            className="text-primary hover:underline"
          >
            Open chat
          </Link>
          <span>
            {task.state.type === "active"
              ? "Working"
              : task.state.type === "submitted"
                ? "Submitted"
                : {
                    succeeded: "Approved",
                    failed: "Failed",
                    cancelled: "Cancelled",
                  }[task.state.outcome.type]}
            {task.state.type === "settled" && task.state.outcome.type !== "succeeded"
              ? `: ${task.state.outcome.reason}`
              : ""}
          </span>
        </div>
      ))}
      {actions.canEditFields ? (
        <StepAutomationsEditor
          entries={view.step.automations}
          busy={busy}
          onSave={(automations) =>
            void act(() =>
              api("workflows.setStepAutomations", { stepId: view.step.id, automations }),
            )
          }
        />
      ) : null}
    </CardFold>
  );
}

/**
 * What still stops the step from being marked done: each empty field, which scrolls to it, and
 * each sub-step not yet approved.
 */
function MissingRecap({
  missing,
  unapproved,
}: {
  readonly missing: ReturnType<typeof missingFields>;
  readonly unapproved: ReadonlyArray<StepNameView>;
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
        {unapproved.map((subStep) => (
          <li key={subStep.id} className="text-destructive">
            Get {subStep.name} approved
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The way back to the workflow's board for those who can open it, the item's title, and the step
 * it is in when that isn't the step on the page.
 */
function ItemHeader({ view }: { readonly view: StepView }) {
  const current =
    view.otherSteps.find(({ step }) => step.id !== view.step.id && step.status.type !== "completed")
      ?.name ?? null;
  return (
    <header className="flex flex-col gap-1">
      {view.canOpenBoard ? (
        <div className="mb-5">
          <BackLink to="/boards/$slug" params={{ slug: view.ticket.workflowId }}>
            {view.workflowName}
          </BackLink>
        </div>
      ) : null}
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

/** The open step's name, the steps it sits in, and why it's blocked or needs changes. */
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
      <h2 className="text-lg font-semibold tracking-tight">{stepNameOf(view)}</h2>
      {step.status.type === "blocked" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Blocked:</span> {step.status.reason}
        </p>
      ) : null}
      {step.status.type === "rejected" ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Changes needed:</span> {step.status.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Details card, collapsible like a ticket's: who has the open step and the item's details.
 * Cancelling and reopening are on the status.
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
  const id = useId();
  const { step, ticket: item } = view;
  const responsible = step.responsible;
  const dueDate = item.dueDate === null ? "" : DateTime.formatIso(item.dueDate).slice(0, 10);
  return (
    <CardFold as="aside" title="Details">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="min-w-0">
          {actions.canSetAssignee ? (
            <AssigneePicker
              current={step.assignee}
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
        <dt className="text-muted-foreground">Responsible</dt>
        <dd className="min-w-0">
          <ActorName actor={responsible} />
        </dd>
        <dt className="text-muted-foreground">
          <label htmlFor={`${id}-due`}>Due date</label>
        </dt>
        <dd className="min-w-0">
          <SavedInput
            id={`${id}-due`}
            type="date"
            size="sm"
            value={dueDate}
            disabled={item.status.type !== "open"}
            onSave={(typed) =>
              void act(() =>
                api("workflows.setTicketDueDate", {
                  ticketId: item.id,
                  dueDate: typed ? DateTime.makeUnsafe(typed) : null,
                }),
              )
            }
          />
        </dd>
        <dt className="text-muted-foreground">Workflow</dt>
        <dd className="min-w-0 truncate">
          {view.canOpenBoard ? (
            <Link to="/boards/$slug" params={{ slug: item.workflowId }} className="hover:underline">
              {view.workflowName}
            </Link>
          ) : (
            view.workflowName
          )}
        </dd>
      </dl>
    </CardFold>
  );
}
