import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";

import { type Agent, canUse } from "./Agent.ts";
import type { Capability } from "./Capability.ts";
import { AutomationId } from "./Automation.ts";
import {
  Field,
  FieldPathSegment,
  Fields,
  FieldValues,
  groupRows,
  hasDistinctIds,
  holdsData,
} from "./Field.ts";
import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "./primitives.ts";

/** A field of an earlier step that a step reads: the whole field, a group with all its rows. */
export const StepInput = Schema.Struct({
  stepId: StringId.annotate({
    description: "The earlier step, or sub-step, that fills the field.",
  }),
  fieldId: FieldPathSegment.annotate({ description: "One of that step's own fields." }),
});
export type StepInput = typeof StepInput.Type;

/** A step as it is stored and sent, where a step may leave out its inputs and automations. */
export interface StepDefinitionEncoded {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly fields: ReadonlyArray<typeof Field.Encoded>;
  readonly subSteps: ReadonlyArray<StepDefinitionEncoded>;
  readonly inputs?: ReadonlyArray<StepInput>;
  readonly automationIds?: ReadonlyArray<string>;
}

export class StepDefinition extends Schema.Class<StepDefinition>("StepDefinition")({
  id: StringId.annotate({
    description: "Identifier unique across all steps and sub-steps in the workflow.",
  }),
  name: TrimmedNonEmptyString,
  instructions: Schema.String,
  fields: Fields,
  subSteps: Schema.Array(
    Schema.suspend((): Schema.Codec<StepDefinition, StepDefinitionEncoded> => StepDefinition),
  ).annotate({
    description:
      "Steps that start with their parent and must all be completed before it can finish.",
  }),
  /**
   * What the step reads of earlier steps, each a field of a step under an earlier step of the
   * workflow; none when left out. Nothing else of other steps reaches whoever works on it.
   */
  inputs: Schema.Array(StepInput).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The automations people run on this step, the same in every project; none when left out. */
  automationIds: Schema.UniqueArray(AutomationId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
}) {}

const stepNodes = (
  steps: ReadonlyArray<StepDefinition>,
  parentId: string | null = null,
): ReadonlyArray<{ readonly step: StepDefinition; readonly parentId: string | null }> =>
  steps.flatMap((step) => [{ step, parentId }, ...stepNodes(step.subSteps, step.id)]);

export const findStep = (steps: ReadonlyArray<StepDefinition>, id: string) =>
  stepNodes(steps).find((node) => node.step.id === id) ?? null;

/** The position, among the workflow's own steps, of the one that is or holds the step `id`. */
const topLevelIndexOf = (steps: ReadonlyArray<StepDefinition>, id: string) =>
  steps.findIndex((step) => stepNodes([step]).some((node) => node.step.id === id));

/** Every input is a field of a step under an earlier step of the workflow, never a sibling's. */
export const hasValidInputs = (steps: ReadonlyArray<StepDefinition>) =>
  stepNodes(steps).every(({ step }) =>
    step.inputs.every((input) => {
      const source = topLevelIndexOf(steps, input.stepId);
      return (
        source >= 0 &&
        source < topLevelIndexOf(steps, step.id) &&
        findStep(steps, input.stepId)!.step.fields.some((field) => field.id === input.fieldId)
      );
    }),
  );

/** A project's name in URLs: lowercase letters and digits, joined by single hyphens. */
export const Slug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(64),
);
export type Slug = typeof Slug.Type;

export const toSlug = (value: string) => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, 64)
    .replace(/^-|-$/gu, "");
  return slug || null;
};

export const stepIds = (steps: ReadonlyArray<StepDefinition>) =>
  stepNodes(steps).map(({ step }) => step.id);

const Steps = Schema.Array(StepDefinition).check(
  Schema.makeFilter((steps) => hasDistinctIds(stepIds(steps)), {
    expected: "distinct step ids, sub-steps included",
  }),
);

/**
 * A reusable process: its name and who edits it. Its steps are in its versions; teams use it
 * through projects, each with its own settings and board.
 */
export class Workflow extends Schema.Opaque<Workflow>()(
  Schema.Struct({
    id: StringId,
    name: TrimmedNonEmptyString,
    creatorUserId: StringId,
    /** The people its creator lets edit it. */
    editorUserIds: Schema.Array(StringId),
    isArchived: Schema.Boolean,
  }),
) {}

/**
 * A workflow's steps as one version has them. It is a draft, which a save overwrites, until a
 * project adopts it: then it is frozen for good and the next save makes the following version.
 */
export class WorkflowVersion extends Schema.Opaque<WorkflowVersion>()(
  Schema.Struct({
    id: StringId,
    workflowId: StringId,
    /** 1 for a workflow's first version, one more for each that follows. */
    number: NonNegativeInt,
    /** Counts a draft's saves, so a save or an adoption of an older draft is refused. */
    revision: NonNegativeInt,
    isFrozen: Schema.Boolean,
    steps: Steps,
  }),
) {}

/** A team's use of a workflow, with its own people, settings and board. */
export class Project extends Schema.Opaque<Project>()(
  Schema.Struct({
    id: StringId,
    workflowId: StringId,
    /** The version new tickets start on; null until the project adopts one. */
    workflowVersionId: Schema.NullOr(StringId),
    name: TrimmedNonEmptyString,
    adminUserIds: Schema.Array(StringId),
    /** Who gets a step when a ticket enters it, by the step's definition id. */
    defaultAssignees: Schema.Record(Schema.String, StringId).check(
      Schema.isPropertyNames(StringId),
    ),
    slug: Schema.NullOr(Slug),
    isArchived: Schema.Boolean,
  }),
) {}

const StepStatus = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["working", "completed"]),
    at: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("blocked"),
    at: Schema.DateTimeUtcFromString,
    reason: TrimmedNonEmptyString,
  }),
]);

/** One step or sub-step of one ticket. */
export class Step extends Schema.Opaque<Step>()(
  Schema.Struct({
    id: StringId.withConstructorDefault,
    stepDefinitionId: StringId,
    /** The step a sub-step belongs to; null for the workflow's own steps. */
    parentStepId: Schema.NullOr(StringId),
    status: StepStatus,
    assignee: Schema.NullOr(StringId),
    /** The values assigned to the fields of the step */
    values: FieldValues,
  }),
) {}

const TicketStatus = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["open", "done"]),
  }),
  Schema.Struct({
    type: Schema.Literal("cancelled"),
    reason: TrimmedNonEmptyString,
  }),
]);

/** Steps are appended on entry, so every parent precedes its children. */
const hasValidStepReferences = (steps: ReadonlyArray<Step>) => {
  const seen = new Set<string>();
  return steps.every((step) => {
    if (seen.has(step.id) || (step.parentStepId !== null && !seen.has(step.parentStepId)))
      return false;
    seen.add(step.id);
    return true;
  });
};

/**
 * A run of a project's workflow, on the version the project had adopted when it started. Nobody
 * owns a ticket: its steps are owned.
 */
export class Ticket extends Schema.Opaque<Ticket>()(
  Schema.Struct({
    id: StringId,
    projectId: StringId,
    workflowVersionId: StringId,
    title: TrimmedNonEmptyString,
    description: Schema.String,
    status: TicketStatus,
    steps: Schema.Array(Step).check(
      Schema.makeFilter(hasValidStepReferences, {
        expected: "unique steps following their parents",
      }),
    ),
    createdAt: Schema.DateTimeUtcFromString,
  }),
) {}

export const currentStep = (ticket: Ticket) =>
  ticket.steps.find((step) => step.parentStepId === null && step.status.type !== "completed") ??
  null;

/**
 * The step of the workflow the ticket is in or, once closed, was in when it closed: the last step
 * of a done ticket, and where a cancelled one stopped.
 */
export const occupiedStep = (ticket: Ticket) =>
  ticket.steps.findLast((step) => step.parentStepId === null) ?? null;

export class Comment extends Schema.Opaque<Comment>()(
  Schema.Struct({
    id: StringId,
    author: StringId,
    body: Schema.String,
    createdAt: Schema.DateTimeUtcFromString,
    stepId: StringId,
  }),
) {}

const REFUSALS = {
  not_project_admin: "Only the project's admins can do that.",
  step_without_members:
    "Choose at least one active member for every step of that version before adopting it.",
  not_step_member: "Only that step's members can be assigned to it.",
  member_assigned:
    "They are still assigned to this step on open tickets. Reassign or unassign those first.",
  invalid_input:
    "A step's input must be a field of a step that comes earlier in the workflow. Remove the inputs that no longer are.",
  inputs_missing: "The next step can't start: one of its inputs has no value.",
  slug_taken: "Another project already has that slug.",
  invalid_people_ref: "That person or agent can no longer be given work.",
  no_steps: "This version has no steps yet.",
  not_adopted: "This project hasn't adopted a version of its workflow yet.",
  not_workflow_editor:
    "Only this workflow's creator, its editors and organization admins can change it.",
  stale_draft: "This workflow changed since you opened it. Reload it and make your changes again.",
  invalid_edit: "That change doesn't fit the workflow's steps.",
  last_admin: "A project needs at least one active admin.",
  cannot_start_ticket: "You can't start tickets in this project.",
  project_archived: "This project is archived.",
  open_tickets: "This project still has open tickets. Finish or cancel them before archiving it.",
  workflow_archived: "This workflow is archived.",
  ticket_not_open: "This ticket is no longer open.",
  step_not_actionable: "This step can't do that right now.",
  step_incomplete: "Fill in every field and complete every sub-step first.",
  reason_required: "Give a reason.",
  invalid_field_value: "That value doesn't fit the field.",
  invalid_attachment: "That file can't be attached here.",
  invalid_automations:
    "An automation is archived, or its agent can't work on steps or is private to someone other than you and this workflow's creator. Choose another.",
};

export class Refused extends Schema.TaggedError<Refused>()("WorkflowRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
  /** What exactly didn't fit, for a person or an agent to correct it. */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail === undefined
      ? REFUSALS[this.reason]
      : `${REFUSALS[this.reason]} ${this.detail}`;
  }
}

type Values = Step["values"];

const fieldsComplete = (fields: ReadonlyArray<Field>, values: Values, prefix = ""): boolean =>
  fields.every((field) => {
    const path = prefix ? `${prefix}.${field.id}` : field.id;
    if (field.type !== "group") return holdsData(values[path]);
    const rows = groupRows(field, values[path]);
    return (
      rows.length > 0 &&
      rows.every((rowId) =>
        fieldsComplete(field.fields, values, rowId === null ? path : `${path}.${rowId}`),
      )
    );
  });

/**
 * The fields a step reads of earlier steps, each with the ticket's step that filled it; an input
 * whose step the ticket never entered is left out.
 */
export const stepInputFields = (
  steps: ReadonlyArray<StepDefinition>,
  ticket: Ticket,
  definition: StepDefinition,
) =>
  definition.inputs.flatMap((input) => {
    const source = ticket.steps.find((step) => step.stepDefinitionId === input.stepId);
    const field = findStep(steps, input.stepId)?.step.fields.find(
      (candidate) => candidate.id === input.fieldId,
    );
    return source === undefined || field === undefined ? [] : [{ source, field }];
  });

/**
 * A step, and the sub-steps that start with it, are entered only when every input has its value;
 * `false` and `0` are values.
 */
export const stepEntryRefusal = (
  steps: ReadonlyArray<StepDefinition>,
  ticket: Ticket,
  definition: StepDefinition,
) =>
  stepNodes([definition]).every(({ step }) => {
    const filled = stepInputFields(steps, ticket, step);
    return (
      filled.length === step.inputs.length &&
      filled.every(({ source, field }) => fieldsComplete([field], source.values))
    );
  })
    ? null
    : ("inputs_missing" as const);

export const isActionable = (step: Step) => step.status.type === "working";

export const isLive = (step: Step) => step.status.type !== "completed";

export interface WorkflowActor {
  readonly id: string;
  readonly isOrgAdmin: boolean;
}

/** Only the admins a project lists cancel its tickets; an organization admin isn't one by role. */
export const isProjectAdmin = (actor: WorkflowActor, project: Project) =>
  project.adminUserIds.includes(actor.id);

/** A project's admins and organization admins set up its people, version and settings. */
export const canManageProject = (actor: WorkflowActor, project: Project) =>
  actor.isOrgAdmin || isProjectAdmin(actor, project);

/** What someone sees of a ticket: all of it, one step of the workflow with its sub-steps, or nothing. */
export type TicketAccess =
  | { readonly type: "all" }
  | { readonly type: "step"; readonly step: Step }
  | null;

/**
 * `memberOf` holds the definition ids of the workflow's steps the person is a member of, in the
 * ticket's project. An open ticket shows to the members of the step it is in, and that step alone.
 * A closed one shows whole to someone who is a member of every step of its version, and otherwise
 * the step it closed in to that step's members. Being an admin shows nothing.
 */
export const ticketAccess = (
  memberOf: ReadonlySet<string>,
  version: WorkflowVersion,
  ticket: Ticket,
): TicketAccess => {
  if (ticket.status.type !== "open" && version.steps.every((step) => memberOf.has(step.id)))
    return { type: "all" };
  const step = occupiedStep(ticket);
  return step !== null && memberOf.has(step.stepDefinitionId) ? { type: "step", step } : null;
};

/** A project must retain an active admin when its administrators change. */
export const lastAdminRefusal = (activeAdminIds: ReadonlyArray<string>) =>
  activeAdminIds.length === 0 ? ("last_admin" as const) : null;

/** Every required field and every sub-step must be complete before the step is marked done. */
export const stepCompletionRefusal = (
  definition: StepDefinition | null,
  ticket: Ticket,
  step: Step,
) =>
  !fieldsComplete(definition?.fields ?? [], step.values) ||
  ticket.steps.some((child) => child.parentStepId === step.id && child.status.type !== "completed")
    ? ("step_incomplete" as const)
    : null;

export const stepInTicket = (ticket: Ticket, stepId: string | null) =>
  ticket.steps.find((step) => step.id === stepId) ?? null;

export const childSteps = (
  ticket: Ticket,
  definitions: ReadonlyArray<StepDefinition>,
  step: Step,
) => {
  const order = (findStep(definitions, step.stepDefinitionId)?.step.subSteps ?? []).map(
    (child) => child.id,
  );
  return ticket.steps
    .filter((child) => child.parentStepId === step.id)
    .toSorted(
      (left, right) => order.indexOf(left.stepDefinitionId) - order.indexOf(right.stepDefinitionId),
    );
};

export const ancestorSteps = (ticket: Ticket, step: Step): ReadonlyArray<Step> => {
  const parent = stepInTicket(ticket, step.parentStepId);
  return parent === null ? [] : [parent, ...ancestorSteps(ticket, parent)];
};

/** The step of the workflow that `step` is or sits in; its members are the sub-step's too. */
export const topLevelStep = (ticket: Ticket, step: Step) =>
  ancestorSteps(ticket, step).at(-1) ?? step;

export const canSeeStep = (access: TicketAccess, ticket: Ticket, step: Step) =>
  access !== null && (access.type === "all" || topLevelStep(ticket, step).id === access.step.id);

/**
 * The steps `userId` is assigned to under the workflow's step `stepDefinitionId`, sub-steps
 * included and completed ones too: while a ticket is open they keep that person a member.
 */
export const stepsAssignedUnder = (ticket: Ticket, stepDefinitionId: string, userId: string) =>
  ticket.steps.filter(
    (step) =>
      step.assignee === userId && topLevelStep(ticket, step).stepDefinitionId === stepDefinitionId,
  );

export const putTicketStep = (ticket: Ticket, step: Step): Ticket => {
  const index = ticket.steps.findIndex((candidate) => candidate.id === step.id);
  return { ...ticket, steps: index < 0 ? [...ticket.steps, step] : ticket.steps.with(index, step) };
};

/** Completing a child leaves its parent active; completing a root advances or finishes the ticket. */
export const completeTicketStep = (
  ticket: Ticket,
  definitions: ReadonlyArray<StepDefinition>,
  step: Step,
  at: DateTime.Utc,
) => {
  const completed = putTicketStep(ticket, { ...step, status: { type: "completed", at } });
  if (step.parentStepId !== null) return { ticket: completed, next: null };
  const index = definitions.findIndex((definition) => definition.id === step.stepDefinitionId);
  const next = index < 0 ? null : (definitions[index + 1] ?? null);
  return {
    ticket: next === null ? { ...completed, status: { type: "done" as const } } : completed,
    next,
  };
};

/**
 * Only the members of the first step of the adopted version start tickets; `adopted` is null
 * before the project's first adoption. No admin role stands in for that membership.
 */
export const ticketStartRefusal = (
  memberOf: ReadonlySet<string>,
  project: Project,
  adopted: WorkflowVersion | null,
) => {
  const first = adopted?.steps[0];
  if (first === undefined) return "not_adopted";
  if (project.isArchived) return "project_archived";
  return memberOf.has(first.id) ? null : "cannot_start_ticket";
};

/** A workflow's creator, the editors they added and organization admins change it. */
export const canEditWorkflow = (actor: WorkflowActor, workflow: Workflow) =>
  actor.isOrgAdmin ||
  workflow.creatorUserId === actor.id ||
  workflow.editorUserIds.includes(actor.id);

/** Only the creator and organization admins say who else edits a workflow. */
export const canSetWorkflowEditors = (actor: WorkflowActor, workflow: Workflow) =>
  actor.isOrgAdmin || workflow.creatorUserId === actor.id;

/**
 * Whether `userId` may attach an automation of `agent` to a step of `workflow`: the agent works
 * steps, is theirs to use and, while private, belongs to the workflow's creator.
 */
export const canAttachAgent = (
  agent: Pick<Agent, "status" | "creatorUserId" | "isPublished">,
  workflow: Workflow,
  userId: string,
  capabilities: ReadonlyArray<Pick<Capability, "requiredContext">>,
) =>
  canWorkSteps(agent, capabilities) &&
  canUse(agent, userId) &&
  (agent.isPublished || agent.creatorUserId === workflow.creatorUserId);

/** A step automation needs a capability that consumes its step context. */
export const canWorkSteps = (
  agent: Pick<Agent, "status">,
  capabilities: ReadonlyArray<Pick<Capability, "requiredContext">>,
) =>
  agent.status === "active" &&
  capabilities.some((capability) => capability.requiredContext?.includes("stepId"));

const stepRef = { stepId: StringId };

/**
 * One change to a version's steps. Steps and a step's own fields are named by id: renaming or
 * moving one keeps its id, and nothing moves a sub-step to another parent.
 */
export const WorkflowEdit = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("add_step"),
    /** An id no version of the workflow ever had. */
    ...stepRef,
    /** The step it becomes a sub-step of; null for a step of the workflow itself. */
    parentStepId: Schema.NullOr(StringId),
    index: NonNegativeInt,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("remove_step"), ...stepRef }),
  Schema.Struct({ type: Schema.Literal("rename_step"), ...stepRef, name: TrimmedNonEmptyString }),
  /** Moves the step among its siblings. */
  Schema.Struct({ type: Schema.Literal("move_step"), ...stepRef, index: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal("set_step_instructions"),
    ...stepRef,
    instructions: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("add_field"),
    ...stepRef,
    index: NonNegativeInt,
    field: Field,
  }),
  Schema.Struct({ type: Schema.Literal("remove_field"), ...stepRef, fieldId: FieldPathSegment }),
  /** Replaces the step's field that has this field's id; a group comes with its own fields. */
  Schema.Struct({ type: Schema.Literal("change_field"), ...stepRef, field: Field }),
  Schema.Struct({
    type: Schema.Literal("move_field"),
    ...stepRef,
    fieldId: FieldPathSegment,
    index: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literals(["attach_automation", "detach_automation"]),
    ...stepRef,
    automationId: AutomationId,
  }),
  Schema.Struct({
    type: Schema.Literals(["bind_input", "unbind_input"]),
    ...stepRef,
    input: StepInput,
  }),
]);
export type WorkflowEdit = typeof WorkflowEdit.Type;

type StepList = ReadonlyArray<StepDefinition>;

const placeAt = <A>(list: ReadonlyArray<A>, index: number, entry: A) =>
  index > list.length ? null : list.toSpliced(index, 0, entry);

const moveTo = <A>(list: ReadonlyArray<A>, from: number, to: number) =>
  from < 0 || to >= list.length ? null : list.toSpliced(from, 1).toSpliced(to, 0, list[from]!);

/** The steps with the list holding `stepId` changed; null when no list holds it or `change` refuses. */
const changeSiblings = (
  steps: StepList,
  stepId: string,
  change: (siblings: StepList, index: number) => StepList | null,
): StepList | null => {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index >= 0) return change(steps, index);
  for (const [at, step] of steps.entries()) {
    const subSteps = changeSiblings(step.subSteps, stepId, change);
    if (subSteps !== null) return steps.with(at, { ...step, subSteps });
  }
  return null;
};

const changeStep = (
  steps: StepList,
  stepId: string,
  change: (step: StepDefinition) => Partial<StepDefinition> | null,
) =>
  changeSiblings(steps, stepId, (siblings, index) => {
    const changed = change(siblings[index]!);
    return changed === null ? null : siblings.with(index, { ...siblings[index]!, ...changed });
  });

export const isSameInput = (input: StepInput) => (other: StepInput) =>
  other.stepId === input.stepId && other.fieldId === input.fieldId;

const applyWorkflowEdit = (steps: StepList, edit: WorkflowEdit): StepList | null => {
  const fieldIndex = (step: StepDefinition, fieldId: string) =>
    step.fields.findIndex((field) => field.id === fieldId);
  const withFields = (fields: ReadonlyArray<Field> | null) => (fields === null ? null : { fields });
  switch (edit.type) {
    case "add_step": {
      const added = {
        id: edit.stepId,
        name: edit.name,
        instructions: "",
        fields: [],
        subSteps: [],
        inputs: [],
        automationIds: [],
      };
      return edit.parentStepId === null
        ? placeAt(steps, edit.index, added)
        : changeStep(steps, edit.parentStepId, (parent) => {
            const subSteps = placeAt(parent.subSteps, edit.index, added);
            return subSteps === null ? null : { subSteps };
          });
    }
    case "remove_step":
      return changeSiblings(steps, edit.stepId, (siblings, index) => siblings.toSpliced(index, 1));
    case "move_step":
      return changeSiblings(steps, edit.stepId, (siblings, index) =>
        moveTo(siblings, index, edit.index),
      );
    case "rename_step":
      return changeStep(steps, edit.stepId, () => ({ name: edit.name }));
    case "set_step_instructions":
      return changeStep(steps, edit.stepId, () => ({ instructions: edit.instructions }));
    case "add_field":
      return changeStep(steps, edit.stepId, (step) =>
        withFields(placeAt(step.fields, edit.index, edit.field)),
      );
    case "remove_field":
      return changeStep(steps, edit.stepId, (step) => {
        const index = fieldIndex(step, edit.fieldId);
        return withFields(index < 0 ? null : step.fields.toSpliced(index, 1));
      });
    case "change_field":
      return changeStep(steps, edit.stepId, (step) => {
        const index = fieldIndex(step, edit.field.id);
        return withFields(index < 0 ? null : step.fields.with(index, edit.field));
      });
    case "move_field":
      return changeStep(steps, edit.stepId, (step) =>
        withFields(moveTo(step.fields, fieldIndex(step, edit.fieldId), edit.index)),
      );
    case "attach_automation":
      return changeStep(steps, edit.stepId, ({ automationIds }) =>
        automationIds.includes(edit.automationId)
          ? null
          : { automationIds: [...automationIds, edit.automationId] },
      );
    case "detach_automation":
      return changeStep(steps, edit.stepId, ({ automationIds }) =>
        automationIds.includes(edit.automationId)
          ? { automationIds: automationIds.filter((id) => id !== edit.automationId) }
          : null,
      );
    case "bind_input":
      return changeStep(steps, edit.stepId, ({ inputs }) =>
        inputs.some(isSameInput(edit.input)) ? null : { inputs: [...inputs, edit.input] },
      );
    case "unbind_input":
      return changeStep(steps, edit.stepId, ({ inputs }) =>
        inputs.some(isSameInput(edit.input))
          ? { inputs: inputs.filter((input) => !isSameInput(edit.input)(input)) }
          : null,
      );
  }
};

const decodeSteps = Schema.decodeUnknownOption(Steps);

/**
 * The steps after the edits, applied in order; null when one doesn't fit them or the result isn't
 * a valid set of steps. `usedStepIds` are the ids every version of the workflow ever had, which a
 * new step can't take: a step that left never comes back under another parent.
 */
export const applyWorkflowEdits = (
  steps: StepList,
  edits: ReadonlyArray<WorkflowEdit>,
  usedStepIds: ReadonlyArray<string>,
): StepList | null => {
  const taken = new Set(usedStepIds);
  let next: StepList | null = steps;
  for (const edit of edits) {
    if (edit.type === "add_step") {
      if (taken.has(edit.stepId)) return null;
      taken.add(edit.stepId);
    }
    next = applyWorkflowEdit(next, edit);
    if (next === null) return null;
  }
  return Option.getOrNull(decodeSteps(next));
};
