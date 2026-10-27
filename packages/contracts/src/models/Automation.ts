import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeId, StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";

export const AutomationId = makeId("AutomationId");
export type AutomationId = typeof AutomationId.Type;

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

/** HMAC-SHA256 over the raw request body. */
export const Signature = Schema.Struct({
  header: TrimmedNonEmptyString,
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String,
  secret: TrimmedNonEmptyString,
});
export type Signature = typeof Signature.Type;

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
  Schema.Struct({ type: Schema.Literal("webhook"), signature: Schema.NullOr(Signature) }),
]);
export type Schedule = typeof Schedule.Type;

export class Automation extends Schema.Opaque<Automation>()(
  Schema.Struct({
    id: AutomationId,
    title: Title,
    prompt: TrimmedNonEmptyString,
    /** The agent each run talks to, in a new chat per run. */
    agentId: StringId,
    isEnabled: Schema.Boolean,
    schedule: Schedule,
    webhookToken: Schema.NullOr(Schema.String),
    nextRunAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    lastError: Schema.NullOr(Schema.String),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

const occurrenceAfter = (schedule: Schedule, from: DateTime.DateTime) => {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") return DateTime.add(from, { milliseconds: schedule.everyMs });
  const hour = Number(schedule.timeOfDay.slice(0, 2));
  const minute = Number(schedule.timeOfDay.slice(3));
  // Days and the time of day are read on the automation's wall clock, so a run
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

export const nextRunAt = (
  automation: Pick<Automation, "isEnabled" | "schedule">,
  from: DateTime.DateTime,
) => {
  if (!automation.isEnabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the automation has no next run.
  try {
    const next = occurrenceAfter(automation.schedule, from);
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
 * Interval schedules are never considered missed: an overdue interval automation
 * catching up with a single run is the desired behaviour.
 */
export const isMissed = (schedule: Schedule, slot: DateTime.DateTime, now: DateTime.DateTime) =>
  schedule.type === "fixed_time" &&
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(slot) > MISSED_FIXED_TIME_GRACE_MS;

export const isSameSchedule = Schema.toEquivalence(Schedule);

const REFUSALS = ["agent_unavailable", "runs_on_request", "not_a_webhook"] as const;

export class Refused extends Schema.TaggedError<Refused>()("AutomationRefused", {
  reason: Schema.Literals(REFUSALS),
}) {
  override get message(): string {
    switch (this.reason) {
      case "agent_unavailable":
        return "This agent was archived or doesn't exist. Choose an active agent.";
      case "runs_on_request":
        return "Webhook automations run when their URL receives a request.";
      case "not_a_webhook":
        return "Only webhook automations have a URL token.";
    }
  }
}
