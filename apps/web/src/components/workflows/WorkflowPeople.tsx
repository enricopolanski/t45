import type { AutomationId } from "@t45/contracts/models/Automation";
import { StepAutomationsEditor } from "../work/StepAutomationsEditor";
import type { StepDefinition, Workflow } from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";

import type { WorkflowInstanceView } from "@t45/contracts/resources/Workflows";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { toastFailure } from "../../state/query";
import { useIsAdmin, useSession } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  AlertDialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { Label } from "../ui/label";
import { PersonPicker } from "../work/PersonPicker";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { actorName } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import type { useWorkflowDetail } from "./useWorkflowDetail";

type Editing = {
  readonly detail: WorkflowInstanceView;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useWorkflowDetail>["run"];
};

/**
 * Who answers for the workflow and who manages it, applying at once. Only admins reach the
 * editor, so everything here is theirs.
 */
export function WorkflowPeople({ detail, busy, run }: Editing) {
  const id = useId();
  const navigate = useNavigate();
  const directory = useWorkDirectory();
  const viewerUserId = useSession()?.userId;
  const isOrganizationAdmin = useIsAdmin();
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const { workflow } = detail;
  const left = (userId: string) =>
    directory.people.find((person) => person.id === userId)?.state === "deactivated";
  const removeAdmin = (userId: StringId) => {
    const request = () =>
      api("workflows.updateInstance", {
        workflowId: workflow.id,
        adminUserIds: workflow.adminUserIds.filter((id) => id !== userId),
      });
    if (userId !== viewerUserId || isOrganizationAdmin) {
      void run(request);
      return;
    }
    setLeaving(true);
    setLeaveError(null);
    void request().then(
      () => void navigate({ to: "/settings/workflows" }),
      (cause: unknown) => {
        setLeaving(false);
        setLeaveError(describeFailure(cause));
      },
    );
  };
  return (
    <section aria-label="People" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">People</h2>
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-responsible`}>Responsible</Label>
          <p className="text-xs text-muted-foreground">Who answers for this process.</p>
          <PersonPicker
            id={`${id}-responsible`}
            aria-label="Responsible"
            value={workflow.responsible}
            onChange={(responsible) =>
              void run(() =>
                api("workflows.updateInstance", { workflowId: workflow.id, responsible }),
              )
            }
            placeholder="Choose a person"
            disabled={busy}
          />
          {left(workflow.responsible) && (
            <ErrorText
              text={`${actorName(directory, workflow.responsible)} has left. Choose who is responsible now.`}
            />
          )}
        </div>
        <div role="group" aria-label="Admins" className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Admins</span>
          <p className="text-xs text-muted-foreground">Can manage this workflow.</p>
          <ul className="flex flex-col gap-1">
            {workflow.adminUserIds.map((userId) => {
              const name = actorName(directory, userId);
              const canRemove =
                left(userId) || workflow.adminUserIds.filter((id) => !left(id)).length > 1;
              return (
                <li key={userId} className="flex items-center gap-2 text-sm">
                  {name}
                  {left(userId) ? <Badge variant="secondary">Left</Badge> : null}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove admin ${name}`}
                    title={canRemove ? undefined : "A workflow needs at least one admin."}
                    disabled={busy || leaving || !canRemove}
                    onClick={() => removeAdmin(userId)}
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
          {leaveError && <ErrorText text={leaveError} />}
          <div className="flex flex-wrap items-center gap-2">
            <PersonPicker
              aria-label="New admin"
              value={null}
              onChange={(admin) =>
                void run(() =>
                  api("workflows.updateInstance", {
                    workflowId: workflow.id,
                    adminUserIds: [...workflow.adminUserIds, admin],
                  }),
                )
              }
              placeholder="Add an admin"
              disabled={busy}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function WorkflowStepPeople({ detail, busy, run }: Editing) {
  const { workflow, definition } = detail;
  const directory = useWorkDirectory();
  const firstId = definition.steps[0]?.id;
  const save = (stepId: string, change: Partial<Workflow["defaultAssignments"][string]>) => {
    const current = workflow.defaultAssignments[stepId] ?? EMPTY_ASSIGNMENT;
    const next = { ...current, ...change };
    const others = Object.fromEntries(
      Object.entries(workflow.defaultAssignments).filter(([id]) => id !== stepId),
    );
    const defaultAssignments =
      next.assignee === null && next.automationIds.length === 0
        ? others
        : { ...others, [stepId]: next };
    return run(() =>
      api("workflows.updateInstance", { workflowId: workflow.id, defaultAssignments }),
    );
  };
  const renderSteps = (
    steps: ReadonlyArray<StepDefinition>,
    parentPath: string | null = null,
  ): ReactNode =>
    steps.map((step) => {
      const assignment = workflow.defaultAssignments[step.id];
      const name = step.name;
      const stepPath = parentPath === null ? name : `${parentPath} / ${name}`;
      const inherited =
        step.id === firstId
          ? "Unassigned"
          : parentPath === null
            ? "Whoever did the step before"
            : `Whoever has ${parentPath}`;
      const assignee = assignment?.assignee ? actorName(directory, assignment.assignee) : inherited;
      return (
        <details key={step.id} className="rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm">
            <span className="font-medium">{name}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {assignee} · {assignment?.automationIds.length ?? 0} automations ·{" "}
              {step.subSteps.length} substeps
            </span>
          </summary>
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Assignee</span>
              <PersonPicker
                aria-label={`${stepPath} assignee`}
                value={assignment?.assignee ?? null}
                onChange={(assignee) => void save(step.id, { assignee })}
                noneLabel={inherited}
                onClear={() => void save(step.id, { assignee: null })}
                placeholder="Choose an assignee"
                disabled={busy}
              />
            </div>
            <StepAutomationsEditor
              automationIds={assignment?.automationIds ?? EMPTY_AUTOMATIONS}
              busy={busy}
              onSave={(automationIds) => save(step.id, { automationIds })}
            />
            {step.subSteps.length > 0 && (
              <div className="ml-3 flex flex-col gap-3 border-l pl-3">
                {renderSteps(step.subSteps, stepPath)}
              </div>
            )}
          </div>
        </details>
      );
    });
  return (
    <section aria-label="Who does each step" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Who does each step</h2>
      {definition.steps.length === 0 && (
        <p className="text-sm text-muted-foreground">No steps yet.</p>
      )}
      {renderSteps(definition.steps)}
    </section>
  );
}

/**
 * Archiving and deleting the workflow, last on the page; deleting goes back to the list. A
 * workflow with items can't be deleted, which the server's refusal says.
 */
export function WorkflowDangerZone({ detail, busy, run }: Editing) {
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { workflow } = detail;
  const archived = workflow.isArchived;
  const remove = () => {
    setConfirmingDelete(false);
    setDeleting(true);
    void api("workflows.deleteInstance", { workflowId: workflow.id }).then(
      () => void navigate({ to: "/settings/workflows" }),
      (cause: unknown) => {
        setDeleting(false);
        toastFailure("Couldn't delete the workflow", cause);
      },
    );
  };
  return (
    <section aria-label="Danger zone" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Danger zone</h2>
      <div className="divide-y divide-border rounded-xl border border-destructive/32 bg-card">
        <ActionRow
          title={archived ? "Unarchive this workflow" : "Archive this workflow"}
          description={
            archived ? "New items can start again." : "Stops new items. Running items finish."
          }
          action={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || deleting}
              onClick={() =>
                void run(() =>
                  api("workflows.updateInstance", {
                    workflowId: workflow.id,
                    isArchived: !archived,
                  }),
                )
              }
            >
              {archived ? "Unarchive" : "Archive"}
            </Button>
          }
        />
        <ActionRow
          title="Delete this workflow"
          description="There's no going back."
          action={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || deleting}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          }
        />
      </div>
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>{`Delete "${workflow.name}"?`}</DialogTitle>
            <DialogDescription>There's no going back.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={remove}>
              Delete
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </section>
  );
}

const EMPTY_AUTOMATIONS: ReadonlyArray<AutomationId> = [];
const EMPTY_ASSIGNMENT = { assignee: null, automationIds: EMPTY_AUTOMATIONS };
