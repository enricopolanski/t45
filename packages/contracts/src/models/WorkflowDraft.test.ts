import { assert, it } from "@effect/vitest";

import type { StepDefinition, StepField } from "./Workflow.ts";
import { definitionFromDraft, type WorkflowDraft } from "./WorkflowDraft.ts";

const draft: WorkflowDraft = {
  name: "GDI",
  steps: [
    {
      name: "GDI",
      instructions: "Record the product identifiers.",
      fields: [
        { label: "VE", type: "text" },
        { label: "EAN", type: "text" },
        {
          label: "GDI",
          type: "group",
          repeatable: true,
          fields: [{ label: "VE", type: "text" }],
        },
      ],
      subSteps: [
        {
          name: "PIM",
          instructions: "Approve the product.",
          fields: [{ label: "OK", type: "boolean" }],
          subSteps: [],
        },
      ],
    },
  ],
};

const fieldIds = (fields: ReadonlyArray<StepField>): ReadonlyArray<string> =>
  fields.flatMap((field) => [field.id, ...(field.type === "group" ? fieldIds(field.fields) : [])]);

const stepIds = (steps: ReadonlyArray<StepDefinition>): ReadonlyArray<string> =>
  steps.flatMap((step) => [step.id, ...fieldIds(step.fields), ...stepIds(step.subSteps)]);

it("assigns independent identities throughout a draft while preserving short names and labels", () => {
  const saved = definitionFromDraft(draft);
  const ids = stepIds(saved.steps);
  assert.lengthOf(ids, 7);
  assert.equal(new Set(ids).size, 7);
  assert.equal(saved.name, "GDI");
  const step = saved.steps[0]!;
  assert.equal(step.name, "GDI");
  assert.equal(step.instructions, draft.steps[0]!.instructions);
  assert.deepEqual(
    step.fields.map((field) => field.label),
    ["VE", "EAN", "GDI"],
  );
  const group = step.fields[2];
  assert(group?.type === "group");
  assert.isTrue(group.repeatable);
  assert.equal(group.fields[0]?.label, "VE");
  assert.equal(step.subSteps[0]?.name, "PIM");
  assert.equal(step.subSteps[0]?.fields[0]?.type, "boolean");
});

it("gives separate saved copies fresh identities without changing the draft", () => {
  const original = JSON.stringify(draft);
  const first = new Set(stepIds(definitionFromDraft(draft).steps));
  const second = stepIds(definitionFromDraft(draft).steps);
  assert.isTrue(second.every((id) => !first.has(id)));
  assert.equal(JSON.stringify(draft), original);
});
