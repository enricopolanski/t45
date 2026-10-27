import { StepField, StepDefinition, WorkflowDefinition } from "@t45/contracts/models/Workflow";
import * as Schema from "effect/Schema";

import { randomUUID } from "../../lib/utils";

export type DraftField = typeof StepField.Encoded;
export type FieldType = DraftField["type"];
export type DraftStep = Omit<typeof StepDefinition.Encoded, "subSteps"> & {
  readonly subSteps: ReadonlyArray<DraftStep>;
};

const decodeSteps = Schema.decodeUnknownSync(WorkflowDefinition.fields.steps);

export const FIELD_TYPES: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  boolean: "Yes/no",
  date: "Date",
  file: "File",
  select: "Select",
  group: "Group",
};

/**
 * A key for a new step, sub-step, field, or group entry: stable once chosen, unique within the
 * workflow.
 */
export function newKey(prefix: "step" | "field" | "row") {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function blankField(): DraftField {
  return { id: newKey("field"), label: "", type: "text" };
}

/**
 * The field as `type`: a select starts with one blank option and a group with one blank field;
 * options and fields go when the type no longer has them.
 */
export function retypeField(field: DraftField, type: FieldType): DraftField {
  const base = {
    id: field.id,
    label: field.label,
    ...(field.description === undefined ? {} : { description: field.description }),
  };
  if (type === "select")
    return { ...base, type, options: field.type === "select" ? field.options : [""] };
  if (type === "group")
    return field.type === "group"
      ? field
      : { ...base, type, fields: [blankField()], repeatable: false };
  return { ...base, type };
}

/** The field with its label and options trimmed, and its group's children cleaned. */
function cleanField(field: DraftField): DraftField {
  const label = field.label.trim();
  if (field.type === "select") {
    return {
      ...field,
      label,
      options: field.options.map((option) => option.trim()),
    };
  }
  if (field.type === "group") {
    return { ...field, label, fields: field.fields.map(cleanField) };
  }
  return { ...field, label };
}

export function blankStep(): DraftStep {
  return {
    id: newKey("step"),
    name: "",
    instructions: "",
    fields: [],
    subSteps: [],
  };
}

/** Moves the entry at `index` by `delta`, keeping the others in order. */
export function moveEntry<A>(
  entries: ReadonlyArray<A>,
  index: number,
  delta: -1 | 1,
): ReadonlyArray<A> {
  const target = index + delta;
  if (target < 0 || target >= entries.length) return entries;
  const next = [...entries];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

export function listEntries<A>(list: ReadonlyArray<A>, onChange: (list: ReadonlyArray<A>) => void) {
  return list.map((entry, index) => ({
    entry,
    index,
    first: index === 0,
    last: index === list.length - 1,
    replace: (next: A) => onChange(list.map((other, at) => (at === index ? next : other))),
    move: (delta: -1 | 1) => onChange(moveEntry(list, index, delta)),
    remove: () => onChange(list.filter((_, at) => at !== index)),
  }));
}

/**
 * The step or sub-step with `id`: the steps leading to it from the workflow's own, itself last;
 * null when it's gone.
 */
export function stepPath(steps: ReadonlyArray<DraftStep>, id: string) {
  const find = (entries: ReadonlyArray<DraftStep>): ReadonlyArray<DraftStep> | null => {
    for (const step of entries) {
      if (step.id === id) return [step];
      const below = find(step.subSteps);
      if (below !== null) return [step, ...below];
    }
    return null;
  };
  return find(steps);
}

/** The steps with the step or sub-step `id` replaced by `update` of it. */
export function updateStep(
  steps: ReadonlyArray<DraftStep>,
  id: string,
  update: (step: DraftStep) => DraftStep,
) {
  const visit = (step: DraftStep): DraftStep =>
    step.id === id ? update(step) : { ...step, subSteps: step.subSteps.map(visit) };
  return steps.map(visit);
}

/** The steps with names and options trimmed, options kept only on select fields, at every depth. */
export function cleanSteps(steps: ReadonlyArray<DraftStep>) {
  const trimmed = (step: DraftStep): DraftStep => ({
    ...step,
    name: step.name.trim(),
    fields: step.fields.map(cleanField),
    subSteps: step.subSteps.map(trimmed),
  });
  return decodeSteps(steps.map(trimmed));
}
