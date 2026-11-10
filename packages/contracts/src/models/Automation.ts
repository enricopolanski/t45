import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { type Agent, canUse } from "./Agent.ts";
import { makeId, StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";
import { canManageUsers, type Role, type State } from "./User.ts";

export const AutomationId = makeId("AutomationId");
export type AutomationId = typeof AutomationId.Type;

export const ScheduleTriggerId = makeId("ScheduleTriggerId");
export type ScheduleTriggerId = typeof ScheduleTriggerId.Type;

const MIN_INTERVAL_MS = 60_000;

/** 24-hour "HH:MM" wall-clock time. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/u));

/** IANA zone id, kept as text so a schedule stores and compares as plain JSON. */
const TimeZone = Schema.String.check(
  Schema.makeFilter((zone: string) => Option.isSome(DateTime.zoneMakeNamed(zone)), {
    expected: "an IANA time zone, such as Europe/Berlin",
  }),
);

const Weekdays = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
  Schema.makeFilter(
    (days: ReadonlyArray<number>) =>
      days.length > 0 && days.every((day, index) => index === 0 || (days[index - 1] ?? day) < day),
    { expected: "at least one weekday from 0 (Sunday) to 6 (Saturday), ascending, each once" },
  ),
);

export const Schedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_INTERVAL_MS)),
  }),
  Schema.Struct({
    type: Schema.Literal("fixed_time"),
    timeOfDay: TimeOfDay,
    timeZone: TimeZone,
    weekdays: Weekdays,
  }),
]);
export type Schedule = typeof Schedule.Type;

export class Automation extends Schema.Opaque<Automation>()(
  Schema.Struct({
    id: AutomationId,
    title: Title,
    prompt: TrimmedNonEmptyString,
    /** The agent each run talks to, in a new chat per run. */
    agentId: StringId,
    /** Archived for good: it runs no more, by hand, on a schedule or on a step. */
    isArchived: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/**
 * Runs an automation on a schedule, on its creator's authority. A disabled one can be enabled
 * again; an archived one stays archived.
 */
export class ScheduleTrigger extends Schema.Opaque<ScheduleTrigger>()(
  Schema.Struct({
    id: ScheduleTriggerId,
    automationId: AutomationId,
    creatorUserId: StringId,
    schedule: Schedule,
    status: Schema.Literals(["enabled", "disabled", "archived"]),
    nextRunAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    /** Why its latest run was refused. */
    lastError: Schema.NullOr(Schema.String),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/**
 * Whether `member` may run an automation of `agent` now: an active admin who can use the agent.
 * Every scheduled run asks it of the schedule's creator.
 */
export const canRun = (
  member: { readonly userId: string; readonly role: Role; readonly state: State },
  agent: Pick<Agent, "status" | "creatorUserId" | "isPublished"> | null,
) =>
  canManageUsers(member) &&
  agent !== null &&
  agent.status === "active" &&
  canUse(agent, member.userId);

const occurrenceAfter = (schedule: Schedule, from: DateTime.DateTime) => {
  if (schedule.type === "interval") return DateTime.add(from, { milliseconds: schedule.everyMs });
  const hour = Number(schedule.timeOfDay.slice(0, 2));
  const minute = Number(schedule.timeOfDay.slice(3));
  // Days and the time of day are read on the schedule's wall clock, so a run
  // keeps its local hour across daylight-saving changes.
  const zoned = DateTime.setZoneNamed(from, schedule.timeZone);
  if (Option.isNone(zoned)) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(zoned.value, { days: offset }), {
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (!schedule.weekdays.includes(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
};

export const nextRunAt = (schedule: Schedule, from: DateTime.DateTime) => {
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the schedule has no next run.
  try {
    const next = occurrenceAfter(schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next))
      ? DateTime.toUtc(next)
      : null;
  } catch {
    return null;
  }
};

/**
 * How late a fixed-time run may fire before it counts as missed. Covers pass
 * jitter and short sleeps, while a server booted hours after the slot skips
 * to the next occurrence instead of firing stale work at a random time.
 */
const MISSED_FIXED_TIME_GRACE_MS = 10 * 60_000;

/**
 * True when a due fixed-time run was missed by more than the grace window and
 * should be rescheduled to its next occurrence instead of firing now.
 * Interval schedules are never considered missed: an overdue interval schedule
 * catching up with a single run is the desired behaviour.
 */
export const isMissed = (schedule: Schedule, slot: DateTime.DateTime, now: DateTime.DateTime) =>
  schedule.type === "fixed_time" &&
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(slot) > MISSED_FIXED_TIME_GRACE_MS;

const REFUSALS = {
  agent_unavailable:
    "This agent is archived or private to someone else. Choose an active agent you can use.",
  attached_agent_unfit:
    "A workflow step runs this automation, so its agent must work on steps and, while private, belong to you and that workflow's creator.",
  not_creator: "Only the person who created a schedule can enable it.",
  creator_cannot_run:
    "This schedule's creator can't run the automation now: they must be an active admin, and its agent active and theirs to use.",
};

export class Refused extends Schema.TaggedError<Refused>()("AutomationRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
  }
}
