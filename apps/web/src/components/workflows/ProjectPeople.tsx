import type { StepDefinition } from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";

import type { ProjectView } from "@t45/contracts/resources/Workflows";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { api, type ApiSuccess } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PersonPicker } from "../work/PersonPicker";
import { ReasonDialog } from "../work/ReasonDialog";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { actorName } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import type { useWorkflowData } from "./useWorkflowData";

type Editing = {
  readonly detail: ProjectView;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useWorkflowData>["run"];
};

/** Who manages the project, applying at once. Only those who manage it reach the editor. */
export function ProjectPeople({ detail, busy, run }: Editing) {
  const navigate = useNavigate();
  const directory = useWorkDirectory();
  const viewerUserId = useSession()?.userId;
  const isOrganizationAdmin = useIsAdmin();
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const { project } = detail;
  const left = (userId: string) =>
    directory.people.find((person) => person.id === userId)?.state === "deactivated";
  const removeAdmin = (userId: StringId) => {
    const request = () =>
      api("workflows.updateProject", {
        projectId: project.id,
        adminUserIds: project.adminUserIds.filter((id) => id !== userId),
      });
    if (userId !== viewerUserId || isOrganizationAdmin) {
      void run(request);
      return;
    }
    setLeaving(true);
    setLeaveError(null);
    void request().then(
      () => void navigate({ to: "/settings/projects" }),
      (cause: unknown) => {
        setLeaving(false);
        setLeaveError(describeFailure(cause));
      },
    );
  };
  return (
    <section aria-label="Admins" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Admins</h2>
      <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          Admins choose the project's people and version, and cancel tickets. They see a step's work
          only as its members.
        </p>
        <ul className="flex flex-col gap-1">
          {project.adminUserIds.map((userId) => {
            const name = actorName(directory, userId);
            const canRemove =
              left(userId) || project.adminUserIds.filter((id) => !left(id)).length > 1;
            return (
              <li key={userId} className="flex items-center gap-2 text-sm">
                {name}
                {left(userId) ? <Badge variant="secondary">Left</Badge> : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove admin ${name}`}
                  title={canRemove ? undefined : "A project needs at least one admin."}
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
        <PersonPicker
          aria-label="New admin"
          value={null}
          onChange={(admin) =>
            void run(() =>
              api("workflows.updateProject", {
                projectId: project.id,
                adminUserIds: [...project.adminUserIds, admin],
              }),
            )
          }
          placeholder="Add an admin"
          disabled={busy}
        />
      </div>
    </section>
  );
}

/** The steps of open tickets that keep `userId` a member of the step `stepId`. */
type Blocked = {
  readonly stepId: string;
  readonly userId: string;
  readonly assignments: ApiSuccess<"workflows.listStepAssignments">;
};

const UNASSIGNED = "unassigned";

/**
 * Who works on each step of the workflow: its members, who alone see its tickets, and who gets it
 * when a ticket enters it. Sub-steps have their step's members. Shows the steps of the version to
 * adopt, and those of the adopted one that it drops.
 */
export function ProjectStepPeople({ detail, busy, run }: Editing) {
  const { project, adopted, latest, members } = detail;
  const directory = useWorkDirectory();
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const steps = [
    ...latest.steps,
    ...(adopted?.steps ?? []).filter((step) => !latest.steps.some(({ id }) => id === step.id)),
  ];
  const membership = (stepId: string, userId: string) => ({
    projectId: project.id,
    stepId,
    userId,
  });
  const showBlocking = async (stepId: string, userId: string) =>
    setBlocked({
      stepId,
      userId,
      assignments: await api("workflows.listStepAssignments", membership(stepId, userId)),
    });
  const removeMember = async (stepId: string, userId: string) => {
    if (await run(() => api("workflows.removeStepMember", membership(stepId, userId))))
      setBlocked(null);
    else await showBlocking(stepId, userId);
  };
  const saveDefault = (stepId: string, assignee: StringId | null) => {
    const others = Object.fromEntries(
      Object.entries(project.defaultAssignees).filter(([id]) => id !== stepId),
    );
    const defaultAssignees = assignee === null ? others : { ...others, [stepId]: assignee };
    return run(() => api("workflows.updateProject", { projectId: project.id, defaultAssignees }));
  };
  const renderDefault = (step: StepDefinition, stepPath: string, inherited: string) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Assignee on entry</span>
      <PersonPicker
        aria-label={`${stepPath} assignee`}
        value={project.defaultAssignees[step.id] ?? null}
        onChange={(assignee) => void saveDefault(step.id, assignee)}
        noneLabel={inherited}
        onClear={() => void saveDefault(step.id, null)}
        placeholder="Choose an assignee"
        disabled={busy}
      />
    </div>
  );
  const renderSubSteps = (
    subSteps: ReadonlyArray<StepDefinition>,
    parentPath: string,
  ): ReactNode =>
    subSteps.length === 0 ? null : (
      <div className="ml-3 flex flex-col gap-3 border-l pl-3">
        {subSteps.map((step) => {
          const stepPath = `${parentPath} / ${step.name}`;
          return (
            <div key={step.id} className="flex flex-col gap-3">
              <span className="text-sm font-medium">{step.name}</span>
              {renderDefault(step, stepPath, `Whoever has ${parentPath}`)}
              {renderSubSteps(step.subSteps, stepPath)}
            </div>
          );
        })}
      </div>
    );
  return (
    <section aria-label="Who does each step" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Who does each step</h2>
      <p className="text-xs text-muted-foreground">
        A step's members see the tickets in it, and nothing of the others. Every step needs a member
        before the project adopts a version.
      </p>
      {steps.length === 0 && <p className="text-sm text-muted-foreground">No steps yet.</p>}
      {steps.map((step, at) => {
        const memberIds = members
          .filter((member) => member.stepId === step.id)
          .map((member) => member.userId);
        const blocking = blocked?.stepId === step.id ? blocked : null;
        return (
          <details key={step.id} className="rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm">
              <span className="font-medium">{step.name}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {memberIds.length === 0
                  ? "No members"
                  : memberIds.map((userId) => actorName(directory, userId)).join(", ")}
              </span>
            </summary>
            <div className="mt-4 flex flex-col gap-3">
              <div role="group" aria-label={`${step.name} members`} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Members</span>
                <ul className="flex flex-col gap-1">
                  {memberIds.map((userId) => {
                    const name = actorName(directory, userId);
                    return (
                      <li key={userId} className="flex items-center gap-2 text-sm">
                        {name}
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove ${name} from ${step.name}`}
                          disabled={busy}
                          onClick={() => void removeMember(step.id, userId)}
                        >
                          <XIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {blocking !== null && blocking.assignments.length > 0 ? (
                  <ul
                    aria-label={`Open tickets assigned to ${actorName(directory, blocking.userId)}`}
                    className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
                  >
                    {blocking.assignments.map((assignment) => (
                      <li key={assignment.stepId} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {assignment.ticketTitle} · {assignment.stepName}
                        </span>
                        <Select
                          value={null}
                          disabled={busy}
                          onValueChange={(choice) => {
                            if (typeof choice !== "string") return;
                            const assignee = choice === UNASSIGNED ? null : choice;
                            void run(() =>
                              api("workflows.setStepAssignee", {
                                stepId: assignment.stepId,
                                assignee,
                              }),
                            ).then(() => showBlocking(blocking.stepId, blocking.userId));
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label={`Reassign ${assignment.ticketTitle}`}
                          >
                            <SelectValue placeholder="Reassign" />
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value={UNASSIGNED}>Nobody</SelectItem>
                            {memberIds
                              .filter((userId) => userId !== blocking.userId)
                              .map((userId) => (
                                <SelectItem key={userId} value={userId}>
                                  {actorName(directory, userId)}
                                </SelectItem>
                              ))}
                          </SelectPopup>
                        </Select>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <PersonPicker
                  aria-label={`New member of ${step.name}`}
                  value={null}
                  onChange={(userId) =>
                    void run(() => api("workflows.addStepMember", membership(step.id, userId)))
                  }
                  placeholder="Add a member"
                  disabled={busy}
                />
              </div>
              {renderDefault(
                step,
                step.name,
                at === 0 ? "Unassigned" : "Whoever did the step before",
              )}
              {renderSubSteps(step.subSteps, step.name)}
            </div>
          </details>
        );
      })}
    </section>
  );
}

/**
 * The project's open tickets as those who manage it see them: a title each, to cancel one. What
 * is in a ticket shows only to its step's members.
 */
export function ProjectTickets({ detail, run }: Editing) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const { openTickets, canCancelTickets } = detail;
  if (openTickets.length === 0) return null;
  return (
    <section aria-label="Open tickets" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Open tickets</h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {openTickets.map((ticket) => (
          <li key={ticket.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
            {canCancelTickets ? (
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => setCancelling(ticket.id)}
              >
                Cancel
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canCancelTickets ? null : (
        <p className="text-xs text-muted-foreground">Only the project's admins cancel tickets.</p>
      )}
      <ReasonDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        title="Cancel this item"
        placeholder="Why it stops here"
        confirmLabel="Cancel item"
        onConfirm={async (reason) => {
          try {
            await api("workflows.cancelTicket", { ticketId: cancelling ?? "", reason });
          } catch (cause) {
            return describeFailure(cause);
          }
          // Re-reads the project, now without the ticket.
          await run(() => Promise.resolve());
          return null;
        }}
      />
    </section>
  );
}

/** Archiving the project, last on the page: for good, so it asks first. */
export function ProjectArchive({ detail, busy, run }: Editing) {
  const [confirming, setConfirming] = useState(false);
  const { project } = detail;
  return (
    <section aria-label="Archive" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Archive</h2>
      <div className="rounded-xl border border-destructive/32 bg-card">
        <ActionRow
          title={project.isArchived ? "This project is archived" : "Archive this project"}
          description="An archived project starts no new item and adopts no version. Its open tickets must be finished or cancelled first. There's no going back."
          action={
            project.isArchived ? (
              <Badge variant="secondary">Archived</Badge>
            ) : (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy || detail.openTickets.length > 0}
                onClick={() => setConfirming(true)}
              >
                Archive
              </Button>
            )
          }
        />
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>{`Archive "${project.name}"?`}</DialogTitle>
            <DialogDescription>There's no going back.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void run(() => api("workflows.archiveProject", { projectId: project.id }));
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </section>
  );
}
