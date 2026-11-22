import * as DateTime from "effect/DateTime";

import { getLocale, translate } from "./i18n/locale";

function makeDateFormatters(language?: string) {
  return {
    time: new Intl.DateTimeFormat(language, { hour: "numeric", minute: "2-digit" }),
    day: new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric" }),
    dayWithYear: new Intl.DateTimeFormat(language, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }),
    fullDate: new Intl.DateTimeFormat(language, { dateStyle: "long" }),
  };
}

const dateFormatters = {
  en: makeDateFormatters(),
  de: makeDateFormatters("de-DE"),
  it: makeDateFormatters("it-IT"),
};

// The English tooltip uses an ordinal before the month.
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
  const locale = getLocale();
  const { time, fullDate } = dateFormatters[locale];
  if (locale !== "en") return `${time.format(date)}, ${fullDate.format(date)}`;
  const day = date.getDate();
  const suffix = ORDINAL_SUFFIXES[ordinals.select(day)] ?? "th";
  return `${time.format(date)}, ${day}${suffix} ${monthNameFormatter.format(date)} ${date.getFullYear()}`;
}

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older `8/13 12:34 PM`
 * (locale digit order), with the year included once the calendar year differs.
 * Boundaries are local calendar days, not 24-hour windows.
 */
export function formatDayAwareTimestamp(instant: DateTime.Utc, now = Date.now()): string {
  const date = DateTime.toDateUtc(instant);
  const formatters = dateFormatters[getLocale()];
  const time = formatters.time.format(date);

  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return translate("yesterday at {0}", time);
  const dateFormatter =
    date.getFullYear() === today.getFullYear() ? formatters.day : formatters.dayWithYear;
  return `${dateFormatter.format(date)} ${time}`;
}

/** `12s ago`, then `3m 05s ago`, then as `formatRelativeTimeLabel` from an hour on. */
export function formatRelativeSecondsLabel(instant: DateTime.Utc, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - DateTime.toEpochMillis(instant)) / 1_000));
  if (seconds < 60) return translate("{0}s ago", seconds);
  if (seconds >= 3_600) return formatRelativeTimeLabel(instant, now);
  return translate(
    "{0}m {1}s ago",
    Math.floor(seconds / 60),
    String(seconds % 60).padStart(2, "0"),
  );
}

/** How long something took: `9s`, then `1m 12s`. */
export function formatDurationLabel(start: DateTime.Utc, end: DateTime.Utc): string {
  const seconds = Math.max(
    0,
    Math.round((DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 1_000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** `just now`, then `3m ago`, `3h ago` or `3d ago`. */
export function formatRelativeTimeLabel(instant: DateTime.Utc, now = Date.now()): string {
  const minutes = Math.floor((now - DateTime.toEpochMillis(instant)) / 60_000);
  if (minutes < 1) return translate("just now");
  if (minutes < 60) return translate("{0}m ago", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? translate("{0}h ago", hours) : translate("{0}d ago", Math.floor(hours / 24));
}
