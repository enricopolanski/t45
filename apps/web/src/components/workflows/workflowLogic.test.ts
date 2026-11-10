import * as Schema from "effect/Schema";
import { applyWorkflowEdits, StepField, stepIds } from "@t45/contracts/models/Workflow";
import type { DraftField, DraftStep } from "./workflowLogic";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanSteps,
  editsBetween,
  inputSourcesFor,
  retypeField,
  moveEntry,
  stepPath,
  updateStep,
} from "./workflowLogic";

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

describe("editsBetween", () => {
  const total: DraftField = { id: "total01", label: "Total", type: "number" };
  const notes: DraftField = { id: "notes01", label: "Notes", type: "text" };
  const saved = cleanSteps([
    step("collect", "Collect", { fields: [total, notes] }),
    step("assess", "Assess", { subSteps: [step("visit01", "Visit"), step("report", "Report")] }),
    step("archive", "Archive"),
  ]);
  /** The saved steps after the edits that lead to `edited`, as the server applies them. */
  const resave = (edited: ReadonlyArray<DraftStep>) =>
    applyWorkflowEdits(saved, editsBetween(saved, cleanSteps(edited)), stepIds(saved));

  it("leads from the saved steps to the edited ones", () => {
    const edited = [
      step("assess", "Assessment", {
        instructions: "Visit, then report.",
        subSteps: [
          step("report", "Report", { fields: [{ id: "result", label: "Result", type: "text" }] }),
          step("survey", "Survey"),
          step("visit01", "Visit"),
        ],
      }),
      step("signoff", "Sign off", {
        fields: [{ ...total, id: "price01" }],
        inputs: [{ stepId: "report", fieldId: "result" }],
        automationIds: ["automation01"],
      }),
      step("collect", "Collect", {
        fields: [
          notes,
          { ...total, type: "text" },
          { id: "added01", label: "Added", type: "date" },
        ],
      }),
    ];
    expect(resave(edited)).toEqual(cleanSteps(edited));
  });

  it("keeps the id of a renamed or moved step, and has nothing to say of unchanged steps", () => {
    expect(editsBetween(saved, saved)).toEqual([]);
    const edited = [saved[2]!, { ...saved[0]!, name: "Gather" }, saved[1]!];
    expect(editsBetween(saved, edited)).toEqual([
      { type: "move_step", stepId: "archive", index: 0 },
      { type: "rename_step", stepId: "collect", name: "Gather" },
    ]);
  });

  it("builds a new workflow's steps from nothing", () => {
    expect(applyWorkflowEdits([], editsBetween([], saved), [])).toEqual(saved);
  });
});

describe("inputSourcesFor", () => {
  const total: DraftField = { id: "total01", label: "Total", type: "number" };
  const steps = [
    step("collect", "Collect", { fields: [total], subSteps: [step("scan01", "Scan")] }),
    step("assess", "Assess", {
      fields: [{ ...total, id: "score01" }],
      subSteps: [step("visit01", "Visit", { fields: [{ ...total, id: "notes01" }] })],
    }),
    step("archive", "Archive"),
  ];
  const sourcesOf = (id: string) =>
    inputSourcesFor(steps, id).map(({ input }) => `${input.stepId}.${input.fieldId}`);

  it("offers the fields of earlier steps and their sub-steps, never a sibling's", () => {
    expect(sourcesOf("collect")).toEqual([]);
    expect(sourcesOf("visit01")).toEqual(["collect.total01"]);
    expect(sourcesOf("archive")).toEqual(["collect.total01", "assess.score01", "visit01.notes01"]);
    expect(inputSourcesFor(steps, "archive")[2]?.label).toBe("Assess › Visit › Total");
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
