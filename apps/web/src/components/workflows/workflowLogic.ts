import {
  isSameInput,
  type StepDefinition,
  type StepDefinitionEncoded,
  type StepInput,
  type WorkflowEdit,
  WorkflowVersion,
} from "@t45/contracts/models/Workflow";
import { Field } from "@t45/contracts/models/Field";
import * as Schema from "effect/Schema";

import { randomUUID } from "../../lib/utils";

export type DraftField = typeof Field.Encoded;
export type FieldType = DraftField["type"];
export type DraftStep = StepDefinitionEncoded;

export const cleanSteps = Schema.decodeSync(WorkflowVersion.fields.steps);

const isSameField = Schema.toEquivalence(Field);

/**
 * The edits that reorder the list `was` into `now`, by id: whatever is new is added in its place,
 * and an entry out of place is moved there. `ids` is the list as the edits so far leave it.
 */
function placeEntries<A extends { readonly id: string }>(
  was: ReadonlyArray<A>,
  now: ReadonlyArray<A>,
  edit: {
    readonly add: (entry: A, index: number) => WorkflowEdit;
    readonly move: (id: string, index: number) => WorkflowEdit;
  },
) {
  const ids = was.map((entry) => entry.id).filter((id) => now.some((entry) => entry.id === id));
  return now.flatMap((entry, index) => {
    if (ids[index] === entry.id) return [];
    const from = ids.indexOf(entry.id);
    if (from >= 0) ids.splice(from, 1);
    ids.splice(index, 0, entry.id);
    return [from < 0 ? edit.add(entry, index) : edit.move(entry.id, index)];
  });
}

/**
 * The edits that turn the saved steps `was` into `now`. A step or field in both keeps its id; what
 * `now` lacks is removed, and what it adds is added under the id the editor gave it.
 */
export function editsBetween(
  saved: ReadonlyArray<StepDefinition>,
  edited: ReadonlyArray<StepDefinition>,
): ReadonlyArray<WorkflowEdit> {
  const ofSteps = (
    parentStepId: string | null,
    was: ReadonlyArray<StepDefinition>,
    now: ReadonlyArray<StepDefinition>,
  ): ReadonlyArray<WorkflowEdit> => [
    ...was
      .filter((old) => !now.some((step) => step.id === old.id))
      .map((old) => ({ type: "remove_step" as const, stepId: old.id })),
    ...placeEntries(was, now, {
      add: (step, index) => ({
        type: "add_step",
        stepId: step.id,
        parentStepId,
        index,
        name: step.name,
      }),
      move: (stepId, index) => ({ type: "move_step", stepId, index }),
    }),
    ...now.flatMap((step) => ofStep(was.find((old) => old.id === step.id) ?? null, step)),
  ];
  const ofStep = (
    old: StepDefinition | null,
    step: StepDefinition,
  ): ReadonlyArray<WorkflowEdit> => {
    const stepId = step.id;
    const fields = old?.fields ?? [];
    return [
      ...(old !== null && old.name !== step.name
        ? [{ type: "rename_step" as const, stepId, name: step.name }]
        : []),
      ...((old?.instructions ?? "") !== step.instructions
        ? [{ type: "set_step_instructions" as const, stepId, instructions: step.instructions }]
        : []),
      ...fields
        .filter((field) => !step.fields.some((kept) => kept.id === field.id))
        .map((field) => ({ type: "remove_field" as const, stepId, fieldId: field.id })),
      ...placeEntries(fields, step.fields, {
        add: (field, index) => ({ type: "add_field", stepId, index, field }),
        move: (fieldId, index) => ({ type: "move_field", stepId, fieldId, index }),
      }),
      ...step.fields.flatMap((field) => {
        const before = fields.find((candidate) => candidate.id === field.id);
        return before === undefined || isSameField(before, field)
          ? []
          : [{ type: "change_field" as const, stepId, field }];
      }),
      ...(old?.inputs ?? [])
        .filter((input) => !step.inputs.some(isSameInput(input)))
        .map((input) => ({ type: "unbind_input" as const, stepId, input })),
      ...step.inputs
        .filter((input) => !old?.inputs.some(isSameInput(input)))
        .map((input) => ({ type: "bind_input" as const, stepId, input })),
      ...(old?.automationIds ?? [])
        .filter((automationId) => !step.automationIds.includes(automationId))
        .map((automationId) => ({ type: "detach_automation" as const, stepId, automationId })),
      ...step.automationIds
        .filter((automationId) => !old?.automationIds.includes(automationId))
        .map((automationId) => ({ type: "attach_automation" as const, stepId, automationId })),
      ...ofSteps(stepId, old?.subSteps ?? [], step.subSteps),
    ];
  };
  return ofSteps(null, saved, edited);
}

export const FIELD_TYPES: Record<FieldType, string> = {
  text: "Text",
  url: "URL",
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

/** The select field with these options; its default goes when it is no longer one of them. */
export function withOptions(
  field: Extract<DraftField, { type: "select" }>,
  options: ReadonlyArray<string>,
): DraftField {
  const { defaultValue, ...rest } = field;
  return typeof defaultValue === "string" &&
    options.some((option) => option.trim() === defaultValue)
    ? { ...field, options }
    : { ...rest, options };
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

/**
 * The fields the step or sub-step `id` may read as inputs: those of the steps, sub-steps included,
 * under the workflow's steps that come before its own.
 */
export function inputSourcesFor(steps: ReadonlyArray<DraftStep>, id: string) {
  const fieldsOf = (
    step: DraftStep,
    path: string,
  ): ReadonlyArray<{ readonly input: StepInput; readonly label: string }> => [
    ...step.fields.map((field) => ({
      input: { stepId: step.id, fieldId: field.id },
      label: `${path} › ${field.label || "Untitled field"}`,
    })),
    ...step.subSteps.flatMap((subStep) =>
      fieldsOf(subStep, `${path} › ${subStep.name || "Untitled sub-step"}`),
    ),
  ];
  const own = steps.findIndex((step) => stepPath([step], id) !== null);
  return steps
    .slice(0, Math.max(own, 0))
    .flatMap((step) => fieldsOf(step, step.name || "Untitled step"));
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
