import { type Agent, canWorkSteps } from "@t45/contracts/models/Agent";
import type { User } from "@t45/contracts/models/User";
import type { Step, Ticket } from "@t45/contracts/models/Workflow";
import type { AssignmentSection } from "@t45/contracts/resources/Assignments";
import type { FieldView } from "@t45/contracts/resources/Workflows";

export const MY_WORK_TITLES: Record<AssignmentSection, string> = {
  to_approve: "To approve",
  to_do: "To do",
  waiting: "Waiting",
};

/** "27 Oct", with the year when it isn't this year's. `date` starts with `YYYY-MM-DD`. */
export function formatDueDate(date: string) {
  const [year = 0, month = 1, day = 1] = date.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(year === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "1 field", "3 fields". */
export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What the viewer may do on the step now, mirroring the commands' checks. */
export const stepActions = (ticket: Ticket, step: Step, viewerUserId: string | undefined) => {
  const open = ticket.status.type === "open";
  const actionable = open && (step.status.type === "working" || step.status.type === "rejected");
  const blocked = open && step.status.type === "blocked";
  const approves =
    open && step.status.type === "waiting_approval" && step.responsible === viewerUserId;
  return {
    canEditFields: actionable,
    canMarkDone: actionable,
    canApprove: approves,
    canReject: approves,
    canSetAssignee: actionable || blocked,
    canBlock: actionable,
    canUnblock: blocked,
    canCancelTicket: open,
    canReopenTicket: ticket.status.type === "cancelled",
  };
};
export type StepActions = ReturnType<typeof stepActions>;

export const missingFields = (
  fields: ReadonlyArray<FieldView>,
  namePrefix = "",
): ReadonlyArray<{ readonly key: string; readonly name: string }> =>
  fields.flatMap((field) => {
    const name = `${namePrefix}${field.label}`;
    if (field.type !== "group") {
      const filled =
        field.type === "file"
          ? field.file !== null
          : field.value !== null && (typeof field.value !== "string" || field.value.trim() !== "");
      return filled ? [] : [{ key: field.key, name }];
    }
    if (field.rows.length === 0) return [{ key: field.key, name }];
    return field.rows.flatMap((row, at) =>
      missingFields(row.fields, field.repeatable ? `${name} › Entry ${at + 1} › ` : `${name} › `),
    );
  });

/**
 * Runs a step command, then re-reads the step; answers with the failure, or null. `quiet` leaves
 * the page's error line to the caller, as a dialog showing its own does.
 */
export type StepAct = (run: () => Promise<unknown>, quiet?: boolean) => Promise<string | null>;

export const STEP_STATE_LABELS: Record<Step["status"]["type"], string> = {
  pending: "Not reached",
  working: "To do",
  waiting_approval: "Waiting for approval",
  blocked: "Blocked",
  rejected: "Changes needed",
  completed: "Approved",
};

export function stepStatus(step: Pick<Step, "status">) {
  const label = STEP_STATE_LABELS[step.status.type];
  switch (step.status.type) {
    case "blocked":
    case "rejected":
      return { label, variant: "warning" } as const;
    case "waiting_approval":
      return { label, variant: "info" } as const;
    default:
      return { label, variant: "outline" } as const;
  }
}

export const stepNameOf = (view: { readonly definition: { readonly name: string } | null }) =>
  view.definition?.name ?? "Removed step";

/** The people and agents work can be given to. */
export interface WorkDirectory {
  readonly people: ReadonlyArray<User>;
  readonly agents: ReadonlyArray<Pick<Agent, "id" | "name" | "status" | "mcpServers">>;
}

/** A display name for a person or agent. */
export function actorName(directory: WorkDirectory, id: string | null) {
  if (id === null) return "Nobody";
  return (
    directory.people.find((person) => person.id === id)?.displayName ??
    directory.agents.find((agent) => agent.id === id)?.name ??
    "Someone"
  );
}

/** Active people or agents eligible for step work. */
export function assignableActors(directory: WorkDirectory, kind: "person" | "agent") {
  return kind === "person"
    ? directory.people
        .filter((person) => person.state === "active")
        .map((person) => ({ id: person.id, label: person.displayName }))
    : directory.agents.filter(canWorkSteps).map((agent) => ({ id: agent.id, label: agent.name }));
}
