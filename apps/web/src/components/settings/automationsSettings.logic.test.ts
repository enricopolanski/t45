import type { Schedule } from "@t45/contracts/models/Automation";
import { describe, expect, it } from "vite-plus/test";

import {
  scheduleFromDraft,
  settingsFromDraft,
  automationToDraft,
} from "./automationsSettings.logic";

const reviewTask = {
  title: "Review issues",
  prompt: "Review open issues",
  isEnabled: true,
  agentId: "agent-reviewer",
};

const withSchedule = (schedule: Schedule) => ({ ...reviewTask, schedule });

describe("fixed-time automations", () => {
  it("saves every day explicitly, in this browser's zone", () => {
    const draft = automationToDraft(
      withSchedule({
        type: "fixed_time",
        timeOfDay: "07:30",
        timeZone: "Pacific/Auckland",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      }),
    );
    expect(settingsFromDraft(draft)).toEqual({
      settings: withSchedule({
        type: "fixed_time",
        timeOfDay: "07:30",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      }),
    });
  });

  it("sends the picked days in ascending order", () => {
    const draft = {
      ...automationToDraft(
        withSchedule({
          type: "fixed_time",
          timeOfDay: "09:00",
          timeZone: "Europe/Berlin",
          weekdays: [1, 2, 3, 4, 5],
        }),
      ),
      weekdays: new Set([5, 0, 3]),
    };
    expect(scheduleFromDraft(draft)).toMatchObject({ weekdays: [0, 3, 5] });
  });
});

describe("interval automations", () => {
  it("refuses an interval under a minute before sending", () => {
    const draft = automationToDraft(withSchedule({ type: "interval", everyMs: 60_000 }));
    expect(settingsFromDraft(draft)).toMatchObject({ settings: { schedule: { everyMs: 60_000 } } });
    expect(settingsFromDraft({ ...draft, intervalMinutes: "0.5" })).toMatchObject({
      problem: { title: "Invalid interval" },
    });
  });
});
