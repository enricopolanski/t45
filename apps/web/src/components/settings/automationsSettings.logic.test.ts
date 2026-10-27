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

describe("webhook automations", () => {
  const signature = {
    header: "x-signature",
    encoding: "base64",
    prefix: "",
    secret: "shared-secret",
  } as const;
  const webhookTask = withSchedule({ type: "webhook", signature });

  it("shows the stored secret and saves the automation's settings back unchanged", () => {
    const draft = automationToDraft(webhookTask);
    expect(draft.signatureSecret).toBe("shared-secret");
    expect(settingsFromDraft(draft)).toEqual({ settings: webhookTask });
  });

  it("refuses a signature without a secret before sending", () => {
    const draft = { ...automationToDraft(webhookTask), signatureSecret: "  " };
    expect(settingsFromDraft(draft)).toEqual({
      problem: {
        title: "Signing secret is required",
        description: "Enter the signature header and secret.",
      },
    });
  });

  it("drops the signature when it is switched off and offers GitHub's settings", () => {
    const draft = automationToDraft(withSchedule({ type: "webhook", signature: null }));
    expect(draft.isSignatureRequired).toBe(false);
    expect(draft.signatureHeader).toBe("x-hub-signature-256");
    expect(scheduleFromDraft(draft)).toEqual({ type: "webhook", signature: null });
  });
});

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
