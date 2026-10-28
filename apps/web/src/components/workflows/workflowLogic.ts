import {
  type StepField,
  type StepDefinition,
  WorkflowDefinition,
} from "@t45/contracts/models/Workflow";
import * as Schema from "effect/Schema";

import { randomUUID } from "../../lib/utils";

export type DraftField = typeof StepField.Encoded;
export type FieldType = DraftField["type"];
export type DraftStep = typeof StepDefinition.Encoded;

export const cleanSteps = Schema.decodeSync(WorkflowDefinition.fields.steps);

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

/** The steps leading to `id`, itself last; null when it's gone. */
export function stepPath(
  steps: ReadonlyArray<DraftStep>,
  id: string,
): ReadonlyArray<DraftStep> | null {
  for (const step of steps) {
    if (step.id === id) return [step];
    const below = stepPath(step.subSteps, id);
    if (below !== null) return [step, ...below];
  }
  return null;
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
