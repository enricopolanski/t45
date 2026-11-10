import type { Agent } from "@t45/contracts/models/Agent";
import { Schedule, type Automation } from "@t45/contracts/models/Automation";
import * as Schema from "effect/Schema";

import type { ApiInput } from "../../rpc/api";

/** The zone a fixed-time automation saved from this browser runs in. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type ScheduleMode = "manual" | "fixed" | "interval";
export interface DraftState {
  readonly title: string;
  readonly prompt: string;
  readonly isEnabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  /** The agent each run talks to; null until one is picked. */
  readonly agentId: Agent["id"] | null;
}

/** A new automation runs on demand until a schedule is chosen. */
export const EMPTY_DRAFT: DraftState = {
  title: "",
  prompt: "",
  isEnabled: true,
  scheduleMode: "manual",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  agentId: null,
};

export function scheduleFromDraft(draft: DraftState): Schedule {
  if (draft.scheduleMode === "manual") return { type: "manual" };
  if (draft.scheduleMode === "interval") {
    return { type: "interval", everyMs: Math.round(Number(draft.intervalMinutes) * 60_000) };
  }
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    timeZone: browserTimeZone(),
    weekdays: [...draft.weekdays].toSorted((left, right) => left - right),
  };
}

const isSchedule = Schema.is(Schedule);

const SCHEDULE_PROBLEMS = {
  manual: { title: "Invalid schedule", description: "Choose how this automation runs." },
  fixed: { title: "Invalid time", description: "Pick a time and at least one day." },
  interval: { title: "Invalid interval", description: "Enter an interval of at least one minute." },
} as const satisfies Record<ScheduleMode, object>;

export function settingsFromDraft(
  draft: DraftState,
):
  | { readonly settings: ApiInput<"automations.create"> }
  | { readonly problem: { readonly title: string; readonly description: string } } {
  const title = draft.title.trim();
  const prompt = draft.prompt.trim();
  if (!title || !prompt || draft.agentId === null) {
    return {
      problem: {
        title: "Automation is incomplete",
        description: "Add a title, prompt, and agent.",
      },
    };
  }
  const schedule = scheduleFromDraft(draft);
  if (!isSchedule(schedule)) return { problem: SCHEDULE_PROBLEMS[draft.scheduleMode] };
  return {
    settings: { title, prompt, agentId: draft.agentId, isEnabled: draft.isEnabled, schedule },
  };
}

export function automationToDraft(
  automation: Pick<Automation, "title" | "prompt" | "isEnabled" | "agentId" | "schedule">,
): DraftState {
  const { schedule } = automation;
  const draft = {
    ...EMPTY_DRAFT,
    title: automation.title,
    prompt: automation.prompt,
    isEnabled: automation.isEnabled,
    agentId: automation.agentId,
  };
  switch (schedule.type) {
    case "manual":
      return { ...draft, scheduleMode: "manual" };
    case "interval":
      return {
        ...draft,
        scheduleMode: "interval",
        intervalMinutes: String(schedule.everyMs / 60_000),
      };
    case "fixed_time":
      return {
        ...draft,
        scheduleMode: "fixed",
        timeOfDay: schedule.timeOfDay,
        weekdays: new Set(schedule.weekdays),
      };
  }
}
