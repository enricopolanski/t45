import type { Agent } from "@t45/contracts/models/Agent";
import { Schedule } from "@t45/contracts/models/Automation";
import * as Schema from "effect/Schema";

import type { ApiInput } from "../../rpc/api";

/** The zone a fixed-time schedule saved from this browser runs in. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface DraftState {
  readonly title: string;
  readonly prompt: string;
  /** The agent each run talks to; null until one is picked. */
  readonly agentId: Agent["id"] | null;
}

export const EMPTY_DRAFT: DraftState = { title: "", prompt: "", agentId: null };

type Problem = { readonly problem: { readonly title: string; readonly description: string } };

export function settingsFromDraft(
  draft: DraftState,
): { readonly settings: ApiInput<"automations.create"> } | Problem {
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
  return { settings: { title, prompt, agentId: draft.agentId } };
}

export interface ScheduleDraft {
  readonly mode: "fixed" | "interval";
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
}

export const EMPTY_SCHEDULE: ScheduleDraft = {
  mode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
};

const isSchedule = Schema.is(Schedule);

const SCHEDULE_PROBLEMS = {
  fixed: { title: "Invalid time", description: "Pick a time and at least one day." },
  interval: { title: "Invalid interval", description: "Enter an interval of at least one minute." },
} as const satisfies Record<ScheduleDraft["mode"], object>;

export function scheduleFromDraft(draft: ScheduleDraft): { readonly schedule: Schedule } | Problem {
  const schedule =
    draft.mode === "interval"
      ? { type: "interval", everyMs: Math.round(Number(draft.intervalMinutes) * 60_000) }
      : {
          type: "fixed_time",
          timeOfDay: draft.timeOfDay,
          timeZone: browserTimeZone(),
          weekdays: [...draft.weekdays].toSorted((left, right) => left - right),
        };
  return isSchedule(schedule) ? { schedule } : { problem: SCHEDULE_PROBLEMS[draft.mode] };
}
