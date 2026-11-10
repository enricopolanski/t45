import { describe, expect, it } from "vite-plus/test";

import { EMPTY_SCHEDULE, scheduleFromDraft } from "./automationsSettings.logic";

describe("fixed-time schedules", () => {
  it("saves every day explicitly, in this browser's zone", () => {
    const draft = {
      ...EMPTY_SCHEDULE,
      timeOfDay: "07:30",
      weekdays: new Set([0, 1, 2, 3, 4, 5, 6]),
    };
    expect(scheduleFromDraft(draft)).toEqual({
      schedule: {
        type: "fixed_time",
        timeOfDay: "07:30",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    });
  });

  it("sends the picked days in ascending order", () => {
    const draft = { ...EMPTY_SCHEDULE, weekdays: new Set([5, 0, 3]) };
    expect(scheduleFromDraft(draft)).toMatchObject({ schedule: { weekdays: [0, 3, 5] } });
  });
});

describe("interval schedules", () => {
  it("refuses an interval under a minute before sending", () => {
    const draft = { ...EMPTY_SCHEDULE, mode: "interval" as const, intervalMinutes: "1" };
    expect(scheduleFromDraft(draft)).toMatchObject({ schedule: { everyMs: 60_000 } });
    expect(scheduleFromDraft({ ...draft, intervalMinutes: "0.5" })).toMatchObject({
      problem: { title: "Invalid interval" },
    });
  });
});
