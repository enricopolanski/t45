import { type Agent } from "@t45/contracts/models/Agent";
import type { User } from "@t45/contracts/models/User";
import type { Step, Ticket } from "@t45/contracts/models/Workflow";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";

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
  "workflows.markStepDone": "marked the step done",
  "workflows.setStepAssignee": "changed the assignee",
  "workflows.blockStep": "blocked the step",
  "workflows.unblockStep": "unblocked the step",
  "workflows.commentOnStep": "commented",
  "workflows.runStepAutomation": "ran an automation",
  "workflows.stopStepAutomation": "stopped an automation",
  "workflows.cancelTicket": "cancelled the item",
};

type HistoryEntry = StepView["history"][number];

const historyLabel = (entry: HistoryEntry, count: number) => {
  if (entry.command === "workflows.setStepField")
    return count === 1 ? "changed a field" : `changed ${count} fields`;
  if (entry.command === "workflows.attachStepFile")
    return count === 1 ? "attached a file" : `attached ${count} files`;
  if (entry.command === "workflows.removeStepFile")
    return count === 1 ? "removed a file" : `removed ${count} files`;
  const label =
    entry.automation !== null &&
    (entry.command === "workflows.runStepAutomation" ||
      entry.command === "workflows.stopStepAutomation")
      ? `${entry.command === "workflows.runStepAutomation" ? "ran" : "stopped"} “${entry.automation.title}”`
      : (HISTORY_LABELS[entry.command] ?? entry.command);
  return count === 1 ? label : `${label} ${count} times`;
};

/** Consecutive actions by the same actor share a row, dated by their latest action. */
export const summarizeHistory = (history: StepView["history"]) => {
  const groups: Array<Array<HistoryEntry>> = [];
  for (const entry of history) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group !== undefined &&
      previous?.command === entry.command &&
      previous.userId === entry.userId &&
      previous.agentId === entry.agentId &&
      previous.automation?.id === entry.automation?.id
    ) {
      group.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups.map((entries) => {
    const entry = entries.at(-1)!;
    const count =
      entry.command === "workflows.setStepField"
        ? new Set(entries.map(({ fieldKey }) => fieldKey)).size
        : entries.length;
    return { ...entry, label: historyLabel(entry, count) };
  });
};

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
