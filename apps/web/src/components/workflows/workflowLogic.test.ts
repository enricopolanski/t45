import * as Schema from "effect/Schema";
import { StepField } from "@t45/contracts/models/Workflow";
import type { DraftField, DraftStep } from "./workflowLogic";
import { describe, expect, it } from "vite-plus/test";

import { cleanSteps, retypeField, moveEntry, stepPath, updateStep } from "./workflowLogic";

const encodeFields = Schema.encodeSync(Schema.Array(StepField));

const step = (id: string, name: string, extra: Partial<DraftStep> = {}): DraftStep => ({
  id,
  name,
  instructions: "",
  fields: [],
  subSteps: [],
  ...extra,
});

describe("select fields", () => {
  it("trims select options", () => {
    const cleaned = cleanSteps([
      step("step001", "Check", {
        fields: [
          {
            id: "field01",
            label: "Outcome",
            type: "select",
            options: [" Approved ", "Declined"],
          },
          { id: "group01", label: "Notes", type: "text" },
        ],
      }),
    ]);
    expect(encodeFields(cleaned[0]?.fields ?? [])).toEqual([
      {
        id: "field01",
        label: "Outcome",
        type: "select",
        options: ["Approved", "Declined"],
      },
      { id: "group01", label: "Notes", type: "text" },
    ]);
  });
});

describe("group fields", () => {
  const width: DraftField = { id: "width01", label: "Width", type: "number" as const };
  it("a group starts with a blank field, and its fields go when it becomes another type", () => {
    const group = retypeField({ id: "group01", label: "Variants", type: "text" }, "group");
    expect(group).toMatchObject({
      type: "group",
      fields: [expect.objectContaining({ type: "text" })],
      repeatable: false,
    });
    expect(
      retypeField({ ...group, type: "group", repeatable: true, fields: [width] }, "text"),
    ).toEqual({ id: "group01", label: "Variants", type: "text" });
  });
  it("cleans fields inside repeatable groups", () => {
    const cleaned = cleanSteps([
      step("step001", "Check", {
        fields: [
          {
            id: "group01",
            label: "Variants",
            type: "group",
            repeatable: true,
            fields: [{ ...width, label: " Width " }],
          },
          { id: "text001", label: "Notes", type: "text" },
        ],
      }),
    ]);
    expect(encodeFields(cleaned[0]?.fields ?? [])).toEqual([
      {
        id: "group01",
        label: "Variants",
        type: "group",
        repeatable: true,
        fields: [width],
      },
      { id: "text001", label: "Notes", type: "text" },
    ]);
  });
});

describe("cleanSteps", () => {
  it("trims names and field labels", () => {
    const cleaned = cleanSteps([
      step("file001", " File "),
      step("check01", "Check", {
        fields: [{ id: "total01", label: " Total ", type: "number" }],
      }),
    ]);
    expect(cleaned.map((entry) => entry.name)).toEqual(["File", "Check"]);
    expect(cleaned[1]?.fields[0]?.label).toBe("Total");
  });
});

describe("moveEntry", () => {
  it("moves an entry within bounds", () => {
    expect(moveEntry(["step001", "b", "c"], 0, 1)).toEqual(["b", "step001", "c"]);
    expect(moveEntry(["step001", "b", "c"], 0, -1)).toEqual(["step001", "b", "c"]);
  });
});

describe("stepPath and updateStep", () => {
  const steps = [
    step("collect", "Collect"),
    step("assess", "Assess", {
      subSteps: [step("appraisal", "Appraisal", { subSteps: [step("visit", "Visit")] })],
    }),
  ];
  it("finds a sub-step at any depth, with the steps leading to it", () => {
    const found = stepPath(steps, "visit");
    expect(found?.map((entry) => entry.id)).toEqual(["assess", "appraisal", "visit"]);
    expect(stepPath(steps, "gone")).toBeNull();
  });
  it("replaces a sub-step at any depth", () => {
    const renamed = updateStep(steps, "visit", (entry) => ({ ...entry, name: "Site visit" }));
    expect(stepPath(renamed, "visit")?.at(-1)?.name).toBe("Site visit");
  });
});
