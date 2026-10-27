import * as DateTime from "effect/DateTime";

// Times follow the browser's locale, including its 12- or 24-hour clock.
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

// Deliberately not the host locale: the tooltip's ordinal suffix and
// day-before-month order below are English, so a localized month alone would
// read "4th Juni 2026". Localizing the whole label is a separate change.
const monthNameFormatter = new Intl.DateTimeFormat("en-US", { month: "long" });
const ordinals = new Intl.PluralRules("en-US", { type: "ordinal" });
const ORDINAL_SUFFIXES: Partial<Record<Intl.LDMLPluralRule, string>> = {
  one: "st",
  two: "nd",
  few: "rd",
};

/** Long-form tooltip label, e.g. `12:04, 4th June 2026`. */
export function formatChatTimestampTooltip(instant: DateTime.Utc): string {
  const date = DateTime.toDateUtc(instant);
  const day = date.getDate();
  const suffix = ORDINAL_SUFFIXES[ordinals.select(day)] ?? "th";
  return `${timeFormatter.format(date)}, ${day}${suffix} ${monthNameFormatter.format(date)} ${date.getFullYear()}`;
}

const numericDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});
const numericDateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older `8/13 12:34 PM`
 * (locale digit order), with the year included once the calendar year differs.
 * Boundaries are local calendar days, not 24-hour windows.
 */
export function formatDayAwareTimestamp(instant: DateTime.Utc, now = Date.now()): string {
  const date = DateTime.toDateUtc(instant);
  const time = timeFormatter.format(date);

  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const dateFormatter =
    date.getFullYear() === today.getFullYear()
      ? numericDateFormatter
      : numericDateWithYearFormatter;
  return `${dateFormatter.format(date)} ${time}`;
}

/** `just now`, then `3m ago`, `3h ago` or `3d ago`. */
export function formatRelativeTimeLabel(instant: DateTime.Utc, now = Date.now()): string {
  const minutes = Math.floor((now - DateTime.toEpochMillis(instant)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Like the relative label in the past, and `in 5m` for an instant in the future (a run's next start). */
export function formatScheduledLabel(instant: DateTime.Utc, now = Date.now()): string {
  const diffMs = DateTime.toEpochMillis(instant) - now;
  if (diffMs <= 0) return formatRelativeTimeLabel(instant, now);
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
