import { type Agent } from "@t45/contracts/models/Agent";
import type { User } from "@t45/contracts/models/User";
import type { Step, Ticket } from "@t45/contracts/models/Workflow";
import type { FieldView } from "@t45/contracts/resources/Workflows";

/** "27 Oct", with the year when it isn't this year's. `date` starts with `YYYY-MM-DD`. */
export function formatDay(date: string) {
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

/**
 * What the viewer, who sees the step as one of its members, may do on it now, mirroring the
 * commands' checks. Cancelling the ticket is for the project's admins: `canCancelTicket`.
 */
export const stepActions = (
  ticket: Pick<Ticket, "status">,
  step: Step,
  canCancelTicket: boolean,
) => {
  const open = ticket.status.type === "open";
  const actionable = open && step.status.type === "working";
  const blocked = open && step.status.type === "blocked";
  return {
    canEditFields: actionable,
    canMarkDone: actionable,
    canSetAssignee: actionable || blocked,
    canBlock: actionable,
    canUnblock: blocked,
    canCancelTicket,
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

/** What a command did, as a step's history says it after the name of who ran it. */
const HISTORY_LABELS: Record<string, string> = {
  "workflows.startTicket": "started the item",
  "workflows.setStepField": "changed a field",
  "workflows.markStepDone": "marked the step done",
  "workflows.setStepAssignee": "changed the assignee",
  "workflows.blockStep": "blocked the step",
  "workflows.unblockStep": "unblocked the step",
  "workflows.commentOnStep": "commented",
  "workflows.attachStepFile": "attached a file",
  "workflows.removeStepFile": "removed a file",
  "workflows.runStepAutomation": "ran an automation",
  "workflows.stopStepAutomation": "stopped an automation",
  "workflows.cancelTicket": "cancelled the item",
};

export const historyLabel = (command: string) => HISTORY_LABELS[command] ?? command;

export const STEP_STATE_LABELS: Record<Step["status"]["type"], string> = {
  working: "To do",
  blocked: "Blocked",
  completed: "Done",
};

export const stepStatus = (step: Pick<Step, "status">) =>
  ({
    label: STEP_STATE_LABELS[step.status.type],
    variant: step.status.type === "blocked" ? "warning" : "outline",
  }) as const;

/** The people and agents work can be given to. */
export interface WorkDirectory {
  readonly people: ReadonlyArray<User>;
  readonly agents: ReadonlyArray<Pick<Agent, "id" | "name" | "status">>;
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

/** Active people eligible for step work. */
export function assignablePeople(directory: WorkDirectory) {
  return directory.people
    .filter((person) => person.state === "active")
    .map((person) => ({ id: person.id, label: person.displayName }));
}
