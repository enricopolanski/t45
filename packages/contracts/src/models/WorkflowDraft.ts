import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { generateId } from "./primitives.ts";
import { StepDefinition, StepField, WorkflowDefinition } from "./Workflow.ts";

const DraftValueField = Schema.Struct(Struct.omit(StepField.members[0].fields, ["id"]));
const DraftSelectField = Schema.Struct(Struct.omit(StepField.members[1].fields, ["id"]));

class DraftGroup extends Schema.Class<DraftGroup>("WorkflowDraftGroup")({
  ...Struct.omit(StepField.members[2].fields, ["id", "fields"]),
  fields: Schema.Array(Schema.suspend((): Schema.Codec<DraftField> => DraftField)),
}) {}

const DraftField = Schema.Union([DraftValueField, DraftSelectField, DraftGroup]);
type DraftField = typeof DraftValueField.Type | typeof DraftSelectField.Type | DraftGroup;

class DraftStep extends Schema.Class<DraftStep>("WorkflowDraftStep")({
  ...Struct.omit(StepDefinition.fields, ["id", "fields", "subSteps"]),
  fields: Schema.Array(DraftField),
  subSteps: Schema.Array(Schema.suspend((): Schema.Codec<DraftStep> => DraftStep)),
}) {}

/** A proposed blueprint's content. Identities are assigned only when it is saved. */
export const WorkflowDraft = Schema.Struct({
  name: WorkflowDefinition.fields.name,
  steps: Schema.Array(DraftStep).check(Schema.isMinLength(1)),
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

const saveField = (field: DraftField): StepField =>
  field.type === "group"
    ? { ...field, id: generateId(), fields: field.fields.map(saveField) }
    : { ...field, id: generateId() };

const saveStep = (step: DraftStep): StepDefinition => ({
  ...step,
  id: generateId(),
  fields: step.fields.map(saveField),
  subSteps: step.subSteps.map(saveStep),
});

/** Each saved blueprint gets its own random step and field identities, including nested ones. */
export const definitionFromDraft = (draft: WorkflowDraft) => ({
  name: draft.name,
  steps: draft.steps.map(saveStep),
});
