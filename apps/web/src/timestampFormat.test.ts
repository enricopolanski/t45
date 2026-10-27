import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeTimeLabel,
  formatScheduledLabel,
} from "./timestampFormat";

// Instants are built from local time so calendar days hold in any test timezone or locale.
const local = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
  DateTime.makeUnsafe(new Date(y, monthIndex, d, h, mi));
const utc = (iso: string) => DateTime.makeUnsafe(iso);

describe("formatChatTimestampTooltip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(["de-DE", "it-IT"])("keeps the English date label in a %s runtime", async (locale) => {
    const DateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales ?? locale, options);
    });
    vi.resetModules();
    const { formatChatTimestampTooltip: format } = await import("./timestampFormat");

    expect(format(local(2026, 5, 4, 14, 4))).toBe("14:04, 4th June 2026");
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [22, "22nd"],
  ])("writes day %i as %s", (day, ordinal) => {
    expect(formatChatTimestampTooltip(local(2026, 4, day, 9, 0))).toContain(
      `, ${ordinal} May 2026`,
    );
  });
});

describe("formatDayAwareTimestamp", () => {
  const now = new Date(2026, 7, 14, 12, 0).getTime();
  const time = (at: DateTime.Utc) =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
      DateTime.toDateUtc(at),
    );

  it("shows time only for today", () => {
    const at = local(2026, 7, 14, 9, 30);
    expect(formatDayAwareTimestamp(at, now)).toBe(time(at));
  });

  it("labels the previous calendar day as yesterday even when under 24h old", () => {
    const at = local(2026, 7, 13, 23, 30);
    const justPastMidnight = new Date(2026, 7, 14, 0, 30).getTime();
    expect(formatDayAwareTimestamp(at, justPastMidnight)).toBe(`yesterday at ${time(at)}`);
  });

  it("prefixes older same-year messages with the numeric date", () => {
    const at = local(2026, 7, 12, 12, 34);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(DateTime.toDateUtc(at));
    expect(formatDayAwareTimestamp(at, now)).toBe(`${datePart} ${time(at)}`);
  });

  it("includes the year once the calendar year differs", () => {
    const at = local(2025, 11, 31, 18, 0);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }).format(DateTime.toDateUtc(at));
    expect(formatDayAwareTimestamp(at, now)).toBe(`${datePart} ${time(at)}`);
  });
});

describe("formatRelativeTimeLabel", () => {
  const now = Date.parse("2026-04-07T12:00:00.000Z");

  it("counts minutes, then hours, then days, and calls the last minute just now", () => {
    expect(formatRelativeTimeLabel(utc("2026-04-07T11:59:30.000Z"), now)).toBe("just now");
    expect(formatRelativeTimeLabel(utc("2026-04-07T12:00:30.000Z"), now)).toBe("just now");
    expect(formatRelativeTimeLabel(utc("2026-04-07T11:45:00.000Z"), now)).toBe("15m ago");
    expect(formatRelativeTimeLabel(utc("2026-04-07T09:00:00.000Z"), now)).toBe("3h ago");
    expect(formatRelativeTimeLabel(utc("2026-04-04T12:00:00.000Z"), now)).toBe("3d ago");
  });
});

describe("formatScheduledLabel", () => {
  const now = Date.parse("2026-04-07T12:00:00.000Z");

  it("labels past instants like the relative label", () => {
    expect(formatScheduledLabel(utc("2026-04-07T11:45:00.000Z"), now)).toBe("15m ago");
  });

  it("labels the run's next start on a minute/hour/day scale", () => {
    expect(formatScheduledLabel(utc("2026-04-07T12:00:20.000Z"), now)).toBe("in under a minute");
    expect(formatScheduledLabel(utc("2026-04-07T12:05:00.000Z"), now)).toBe("in 5m");
    expect(formatScheduledLabel(utc("2026-04-07T15:00:00.000Z"), now)).toBe("in 3h");
    expect(formatScheduledLabel(utc("2026-04-09T12:00:00.000Z"), now)).toBe("in 2d");
  });
});
