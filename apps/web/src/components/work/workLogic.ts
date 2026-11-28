import { type Message, type Translate, translate } from "~/i18n/locale";
import { type Agent } from "@t45/contracts/models/Agent";
import type { User } from "@t45/contracts/models/User";
import type { AutomationSkipReason, Step, Ticket } from "@t45/contracts/models/Workflow";
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

/** Numbers are written with a decimal comma, whatever the browser's language. */
const NUMBER_LOCALE = "de-DE";

export const currencyFractionLimit = (unit: string | undefined) =>
  /\p{Sc}/u.test(unit ?? "") ? 3 : undefined;

/**
 * An explicit maximum rounds without padding. Field precision allows an extra place below 1.
 * Prices show at most three decimal places and pad to at most two.
 */
export const formatNumber = (
  value: number,
  {
    decimals,
    maximumFractionDigits,
    unit,
  }: {
    readonly decimals?: number | undefined;
    readonly maximumFractionDigits?: number | undefined;
    readonly unit?: string | undefined;
  },
) => {
  const places =
    decimals === undefined
      ? undefined
      : decimals + (decimals > 0 && Math.abs(value) < 1 && value !== 0 ? 1 : 0);
  const currencyLimit = currencyFractionLimit(unit);
  const minimumFractionDigits =
    maximumFractionDigits !== undefined
      ? 0
      : currencyLimit === undefined
        ? places
        : Math.min(decimals ?? 2, 2);
  const shown = new Intl.NumberFormat(NUMBER_LOCALE, {
    useGrouping: false,
    minimumFractionDigits,
    maximumFractionDigits: maximumFractionDigits ?? Math.min(places ?? 20, currencyLimit ?? 20),
  }).format(value);
  return unit === undefined ? shown : `${shown}${unit === "%" ? "" : " "}${unit}`;
};

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
      missingFields(
        row.fields,
        field.repeatable ? translate("{0} › Entry {1} › ", name, at + 1) : `${name} › `,
      ),
    );
  });

/**
 * Runs a step command, then re-reads the step; answers with the failure, or null. `quiet` leaves
 * the page's error line to the caller, as a dialog showing its own does.
 */
export type StepAct = (run: () => Promise<unknown>, quiet?: boolean) => Promise<string | null>;

/** What a command did, as a step's history says it after the name of who ran it. */
const HISTORY_LABELS: Record<string, Message> = {
  "workflows.startTicket": "started the item",
  "workflows.markStepDone": "marked the step done",
  "workflows.setStepAssignee": "changed the assignee",
  "workflows.blockStep": "blocked the step",
  "workflows.unblockStep": "unblocked the step",
  "workflows.commentOnStep": "commented",
  "workflows.confirmRecordEntry": "confirmed a record review",
  "workflows.setProposalFilters": "updated proposal filters",
  "workflows.reviewProposals": "reviewed proposals",
  "workflows.runStepAutomation": "ran an automation",
  "workflows.stopStepAutomation": "stopped an automation",
  "workflows.cancelTicket": "cancelled the item",
};

type HistoryEntry = StepView["history"][number];

const historyLabel = (entry: HistoryEntry, count: number, t: Translate) => {
  if (entry.command === "workflows.setStepField")
    return t(count === 1 ? "changed a field" : "changed {0} fields", count);
  if (entry.command === "workflows.proposeStepField")
    return t(count === 1 ? "proposed a value" : "proposed {0} values", count);
  if (entry.command === "workflows.approveProposal")
    return t(count === 1 ? "approved a proposal" : "approved {0} proposals", count);
  if (entry.command === "workflows.discardProposal")
    return t(count === 1 ? "discarded a proposal" : "discarded {0} proposals", count);
  if (entry.command === "workflows.attachStepFile")
    return t(count === 1 ? "attached a file" : "attached {0} files", count);
  if (entry.command === "workflows.removeStepFile")
    return t(count === 1 ? "removed a file" : "removed {0} files", count);
  const message = HISTORY_LABELS[entry.command];
  const label =
    entry.automation !== null &&
    (entry.command === "workflows.runStepAutomation" ||
      entry.command === "workflows.stopStepAutomation")
      ? t(
          entry.command === "workflows.stopStepAutomation"
            ? "stopped “{0}”"
            : entry.isAutomatic
              ? "ran “{0}” automatically on step entry"
              : "ran “{0}”",
          entry.automation.title,
        )
      : message === undefined
        ? entry.command
        : t(message);
  return count === 1 ? label : t("{0} {1} times", label, count);
};

/** Consecutive actions by the same actor share a row, dated by their latest action. */
export const summarizeHistory = (history: StepView["history"], t: Translate = translate) => {
  const groups: Array<Array<HistoryEntry>> = [];
  for (const entry of history) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group !== undefined &&
      previous?.command === entry.command &&
      previous.userId === entry.userId &&
      previous.agentId === entry.agentId &&
      previous.isAutomatic === entry.isAutomatic &&
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
    return { ...entry, label: historyLabel(entry, count, t) };
  });
};

/** Why entering the step didn't start an automation, told to whoever views the step. */
export const AUTOMATION_SKIP_REASONS = {
  no_assignee:
    "Nobody was assigned when the step started, and automatic runs use the assignee's permissions. Assign someone, then run it here.",
  automation_unavailable: "The automation is archived, or the step's assignee can't use its agent.",
  step_too_large: "This step's text or files are too large to send to the automation.",
  file_unavailable:
    "A file on this step is no longer available, so the automation couldn't receive it.",
} as const satisfies Record<AutomationSkipReason, Message>;

export const STEP_STATE_LABELS = {
  working: "To do",
  blocked: "Blocked",
  completed: "Done",
} as const satisfies Record<Step["status"]["type"], Message>;

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
/**
 * A run's number on its step, shared by every phase of one run of the automation: the first phases
 * up to its own, among `runs` listed newest first.
 */
export const runNumber = <Run extends { readonly phase: number }>(
  runs: ReadonlyArray<Run>,
  run: Run,
) => runs.slice(runs.indexOf(run)).filter(({ phase }) => phase === 1).length;

/** What a run is called: its phase's name, else its automation's, numbered once it has phases. */
export function runTitle(
  automation: {
    readonly title: string;
    readonly firstPhaseTitle?: string;
    readonly nextPhases?: ReadonlyArray<{ readonly title?: string }>;
  },
  phase: number,
) {
  const name = phase === 1 ? automation.firstPhaseTitle : automation.nextPhases?.[phase - 2]?.title;
  if (name !== undefined) return name;
  return (automation.nextPhases ?? []).length === 0
    ? automation.title
    : `${automation.title} · ${translate("Phase {0}", phase)}`;
}

export function actorName(directory: WorkDirectory, id: string | null) {
  if (id === null) return translate("Nobody");
  return (
    directory.people.find((person) => person.id === id)?.displayName ??
    directory.agents.find((agent) => agent.id === id)?.name ??
    translate("Someone")
  );
}

/** Active people eligible for step work. */
export function assignablePeople(directory: WorkDirectory) {
  return directory.people
    .filter((person) => person.state === "active")
    .map((person) => ({ id: person.id, label: person.displayName }));
}

/** A step named "Step 2 — Market analysis": its number and its name without it. */
export const stepNameParts = /^Step (\d+)\s+[—–-]\s+(.+)$/iu;
