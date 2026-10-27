import { StepAutomationsEditor } from "../work/StepAutomationsEditor";
import {
  hasInitialWork,
  type StepAutomation,
  type StepDefinition,
  type Workflow,
} from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";

import type { WorkflowInstanceView } from "@t45/contracts/resources/Workflows";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useId, useState } from "react";

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
import { Label } from "../ui/label";
import { PersonPicker } from "../work/ActorPicker";
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
      () => void navigate({ to: "/workflows" }),
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
          {left(workflow.responsible) ? (
            <p role="alert" className="text-sm text-destructive">
              {actorName(directory, workflow.responsible)} has left. Steps that would go to them go
              to the longest-serving admin until you choose who is responsible now.
            </p>
          ) : null}
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
          {leaveError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {leaveError}
            </p>
          ) : null}
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

const stepRows = (
  steps: ReadonlyArray<StepDefinition>,
  parentName: string | null = null,
): ReadonlyArray<{
  readonly step: StepDefinition;
  readonly name: string;
  readonly parentName: string | null;
}> =>
  steps.flatMap((step) => {
    const name = parentName === null ? step.name : `${parentName} › ${step.name}`;
    return [{ step, name, parentName }, ...stepRows(step.subSteps, name)];
  });

export function WorkflowStepPeople({ detail, busy, run }: Editing) {
  const { workflow, definition } = detail;
  const rows = stepRows(definition.steps);
  const firstId = definition.steps[0]?.id;
  const save = (stepId: string, change: Partial<Workflow["defaultAssignments"][string]>) => {
    const current = workflow.defaultAssignments[stepId] ?? EMPTY_ASSIGNMENT;
    const next = { ...current, ...change };
    const others = Object.fromEntries(
      Object.entries(workflow.defaultAssignments).filter(([id]) => id !== stepId),
    );
    const defaultAssignments =
      next.assignee === null && next.responsible === null && next.automations.length === 0
        ? others
        : { ...others, [stepId]: next };
    void run(() =>
      api("workflows.updateInstance", { workflowId: workflow.id, defaultAssignments }),
    );
  };
  return (
    <section aria-label="Who does each step" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Who does each step</h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No steps yet.</p>
        ) : null}
        {rows.map(({ step, name, parentName }) => {
          const assignment = workflow.defaultAssignments[step.id];
          const isFirst = step.id === firstId;
          return (
            <div key={step.id} className="flex flex-col gap-3 px-4 py-3">
              <p className="truncate text-sm font-medium">{name}</p>
              {isFirst && !hasInitialWork(workflow, definition) ? (
                <p className="text-xs text-destructive">
                  Tickets can start once the first step has an assignee or automation.
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Assignee</span>
                  <PersonPicker
                    aria-label={`${name} assignee`}
                    value={assignment?.assignee ?? null}
                    onChange={(assignee) => save(step.id, { assignee })}
                    {...(isFirst
                      ? {}
                      : {
                          noneLabel:
                            parentName === null
                              ? "Whoever did the step before"
                              : "Whoever has the step it sits in",
                          onClear: () => save(step.id, { assignee: null }),
                        })}
                    placeholder="Choose an assignee"
                    disabled={busy}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Responsible</span>
                  <PersonPicker
                    aria-label={`${name} responsible`}
                    value={assignment?.responsible ?? null}
                    onChange={(responsible) => save(step.id, { responsible })}
                    noneLabel="The workflow's responsible"
                    onClear={() => save(step.id, { responsible: null })}
                    placeholder="Choose who approves"
                    disabled={busy}
                  />
                </div>
              </div>
              <StepAutomationsEditor
                entries={assignment?.automations ?? EMPTY_AUTOMATIONS}
                busy={busy}
                onSave={(automations) => save(step.id, { automations })}
              />
            </div>
          );
        })}
      </div>
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
  const archived = workflow.archivedAt !== null;
  const remove = () => {
    setConfirmingDelete(false);
    setDeleting(true);
    void api("workflows.deleteInstance", { workflowId: workflow.id }).then(
      () => void navigate({ to: "/workflows" }),
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

const EMPTY_AUTOMATIONS: ReadonlyArray<StepAutomation> = [];
const EMPTY_ASSIGNMENT = { assignee: null, responsible: null, automations: EMPTY_AUTOMATIONS };
