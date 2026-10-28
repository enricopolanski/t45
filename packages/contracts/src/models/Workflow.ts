import * as Schema from "effect/Schema";
import type { Task } from "./Task.ts";
import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";

import { AttachmentId, StringId, TrimmedNonEmptyString } from "./primitives.ts";

const isFieldPathSegment = Schema.isPattern(/^[A-Za-z0-9_-]+$/);

/** A field or row ID; dots separate these IDs in field paths. */
export const FieldPathSegment = StringId.check(isFieldPathSegment);

const hasDistinctIds = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length;

const FieldBase = {
  id: FieldPathSegment,
  label: TrimmedNonEmptyString,
  /** What to put in it, shown under the label. */
  description: Schema.optionalKey(Schema.String),
};

const ValueField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literals(["text", "number", "boolean", "date", "file"]),
});

const SelectField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("select"),
  options: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});

class GroupField extends Schema.Class<GroupField>("GroupField")({
  ...FieldBase,
  type: Schema.Literal("group"),
  repeatable: Schema.Boolean,
  fields: Schema.Array(Schema.suspend((): Schema.Codec<StepField> => StepField)),
}) {}

export const StepField = Schema.Union([ValueField, SelectField, GroupField]);

export type StepField = typeof ValueField.Type | typeof SelectField.Type | GroupField;

const fieldIdsAreDistinct = (fields: ReadonlyArray<StepField>): boolean =>
  hasDistinctIds(fields.map((field) => field.id)) &&
  fields.every((field) => field.type !== "group" || fieldIdsAreDistinct(field.fields));

export class StepDefinition extends Schema.Class<StepDefinition>("StepDefinition")({
  id: StringId,
  name: TrimmedNonEmptyString,
  instructions: Schema.String,
  fields: Schema.Array(StepField).check(
    Schema.makeFilter(fieldIdsAreDistinct, { expected: "distinct field ids among siblings" }),
  ),
  /** Start with their parent, which can't be done until every one is approved. */
  subSteps: Schema.Array(Schema.suspend((): Schema.Codec<StepDefinition> => StepDefinition)),
}) {}

const stepNodes = (
  steps: ReadonlyArray<StepDefinition>,
  parentId: string | null = null,
): ReadonlyArray<{ readonly step: StepDefinition; readonly parentId: string | null }> =>
  steps.flatMap((step) => [{ step, parentId }, ...stepNodes(step.subSteps, step.id)]);

export const findStep = (steps: ReadonlyArray<StepDefinition>, id: string) =>
  stepNodes(steps).find((node) => node.step.id === id) ?? null;

/** A workflow's name in URLs: lowercase letters and digits, joined by single hyphens. */
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

/**
 * The blueprint of a process, can be used by different teams, each with their own settings and board.
 */
export class WorkflowDefinition extends Schema.Opaque<WorkflowDefinition>()(
  Schema.Struct({
    id: StringId,
    name: TrimmedNonEmptyString,
    steps: Schema.Array(StepDefinition).check(
      Schema.makeFilter((steps) => hasDistinctIds(stepNodes(steps).map(({ step }) => step.id)), {
        expected: "distinct step ids, sub-steps included",
      }),
    ),
    isArchived: Schema.Boolean,
  }),
) {}

export const StepAutomation = Schema.Struct({
  id: StringId,
  agentId: StringId,
  instructions: Schema.String,
});
export type StepAutomation = typeof StepAutomation.Type;

export const automationsSubmitted = (
  entries: ReadonlyArray<StepAutomation>,
  tasks: ReadonlyArray<Pick<Task, "trigger" | "state">>,
) =>
  entries.length > 0 &&
  entries.every((entry) =>
    tasks.some((task) => task.trigger.automationId === entry.id && task.state.type === "submitted"),
  );

const StepAutomations = Schema.Array(StepAutomation).check(
  Schema.makeFilter((entries) => hasDistinctIds(entries.map((entry) => entry.id)), {
    expected: "distinct automation identities",
  }),
);

/**
 * An actual instance. It references an original WorkflowDefinition and provides additional data.
 */
export class Workflow extends Schema.Opaque<Workflow>()(
  Schema.Struct({
    id: StringId,
    definitionId: StringId,
    name: TrimmedNonEmptyString,
    responsible: StringId,
    adminUserIds: Schema.Array(StringId),
    defaultAssignments: Schema.Record(
      Schema.String,
      Schema.Struct({
        automations: StepAutomations,
        assignee: Schema.NullOr(StringId),
        responsible: Schema.NullOr(StringId),
      }),
    ).check(Schema.isPropertyNames(StringId)),
    slug: Schema.NullOr(Slug),
    isPublic: Schema.Boolean,
    isArchived: Schema.Boolean,
  }),
) {}

const StepStatus = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["working", "waiting_approval", "completed"]),
    at: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literals(["blocked", "rejected"]),
    at: Schema.DateTimeUtcFromString,
    reason: TrimmedNonEmptyString,
  }),
]);

/** One step or sub-step of one ticket, with the people resolved when the ticket entered it. */
export class Step extends Schema.Opaque<Step>()(
  Schema.Struct({
    id: StringId.withConstructorDefault,
    stepDefinitionId: StringId,
    /** The step a sub-step belongs to; null for the workflow's own steps. */
    parentStepId: Schema.NullOr(StringId),
    status: StepStatus,
    automations: StepAutomations,
    assignee: Schema.NullOr(StringId),
    responsible: StringId,
    /** The values assigned to the fields of the step */
    values: Schema.Record(Schema.String, Schema.Json).check(
      Schema.isPropertyNames(Schema.toType(TrimmedNonEmptyString)),
    ),
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

/** A run of a workflow. Nobody owns a ticket: its steps are owned. */
export class Ticket extends Schema.Opaque<Ticket>()(
  Schema.Struct({
    id: StringId,
    workflowId: StringId,
    title: TrimmedNonEmptyString,
    description: Schema.String,
    dueDate: Schema.NullOr(Schema.DateTimeUtcFromString),
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
  not_workflow_admin: "Only the workflow's admins can do that.",
  slug_taken: "Another workflow already has that slug.",
  invalid_people_ref: "That person or agent can no longer be given work.",
  no_steps: "The workflow has no steps yet.",
  tickets_cannot_move:
    "Some open tickets are in, or have passed, a step you removed or moved. Restore it, or finish or cancel those tickets first.",
  archive_instead_of_delete: "A workflow with tickets can't be deleted. Archive it instead.",
  last_admin: "A workflow needs at least one active admin.",
  not_overseer: "Only the workflow's responsible and admins can do that.",
  cannot_start_ticket: "You can't start tickets in this workflow.",
  first_step_unassigned: "Assign the first step before starting a ticket.",
  not_step_responsible: "Only the step's responsible can do that.",
  workflow_archived: "This workflow is archived.",
  ticket_not_open: "This ticket is no longer open.",
  step_not_actionable: "This step can't do that right now.",
  step_incomplete: "Fill in every field and get every sub-step approved first.",
  reason_required: "Give a reason.",
  invalid_field_value: "That value doesn't fit the field.",
  invalid_attachment: "That file can't be attached here.",
  invalid_automations: "Choose available agents and distinct automation identities.",
};

export class Refused extends Schema.TaggedError<Refused>()("WorkflowRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
  }
}

type Values = Step["values"];

const holdsData = (value: Schema.Json | undefined): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim() !== "") &&
  (!Array.isArray(value) || value.length > 0);

const isRowIds = Schema.is(Schema.UniqueArray(FieldPathSegment));

export const rowIds = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  isRowIds(value) ? value : [];

export const groupRows = (field: StepField, value: Schema.Json | undefined) =>
  field.type === "group" && field.repeatable ? rowIds(value) : [null];

const withinField = (path: string, id: string) => path === id || path.startsWith(`${id}.`);

export const resolveFieldPath = (
  fields: ReadonlyArray<StepField>,
  path: string,
): {
  readonly field: StepField;
  readonly rows: ReadonlyArray<{ readonly groupPath: string; readonly rowId: string }>;
} | null => {
  const segments = path.split(".");
  const rows: Array<{ groupPath: string; rowId: string }> = [];
  let list = fields;
  let prefix = "";
  for (let at = 0; at < segments.length;) {
    const field = list.find((candidate) => candidate.id === segments[at]);
    if (field === undefined) return null;
    prefix = prefix ? `${prefix}.${field.id}` : field.id;
    at += 1;
    if (at === segments.length) return { field, rows };
    if (field.type !== "group") return null;
    if (field.repeatable) {
      const rowId = segments[at];
      at += 1;
      if (rowId === undefined || at === segments.length) return null;
      rows.push({ groupPath: prefix, rowId });
      prefix = `${prefix}.${rowId}`;
    }
    list = field.fields;
  }
  return null;
};

const fieldsComplete = (fields: ReadonlyArray<StepField>, values: Values, prefix = ""): boolean =>
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

export const carriedFields = (
  steps: ReadonlyArray<StepDefinition>,
  rootId: string,
  reached: ReadonlyArray<Step>,
) => {
  const index = steps.findIndex((step) => step.id === rootId);
  if (index < 0) return [];
  return stepNodes(steps.slice(0, index)).flatMap(({ step: definition }) => {
    const source = reached.find((step) => step.stepDefinitionId === definition.id);
    if (source === undefined) return [];
    return definition.fields
      .filter((field) =>
        Object.entries(source.values).some(
          ([path, value]) => withinField(path, field.id) && holdsData(value),
        ),
      )
      .map((field) => ({ source, definition, field }));
  });
};

export const isActionable = (step: Step) =>
  step.status.type === "working" || step.status.type === "rejected";

export const isLive = (step: Step) => isActionable(step) || step.status.type === "blocked";

const fits = (steps: ReadonlyArray<StepDefinition>, ticket: Ticket, step: Step) => {
  const node = findStep(steps, step.stepDefinitionId);
  if (node === null) return step.status.type === "completed";
  const parent = ticket.steps.find((candidate) => candidate.id === step.parentStepId);
  return node.parentId === (parent?.stepDefinitionId ?? null);
};

export interface WorkflowActor {
  readonly id: string;
  readonly isOrgAdmin: boolean;
}

export const isAdmin = (actor: WorkflowActor, workflow: Workflow) =>
  actor.isOrgAdmin || workflow.adminUserIds.includes(actor.id);

export const oversees = (actor: WorkflowActor, workflow: Workflow) =>
  workflow.responsible === actor.id || isAdmin(actor, workflow);

export const isInvolved = (actor: WorkflowActor, workflow: Workflow, ticket: Ticket) =>
  ticket.steps.some((step) => step.assignee === actor.id || step.responsible === actor.id) ||
  oversees(actor, workflow);

export const canViewTicket = (actor: WorkflowActor, workflow: Workflow, ticket: Ticket) =>
  workflow.isPublic || isInvolved(actor, workflow, ticket);

export const hasInitialWork = (workflow: Workflow, definition: WorkflowDefinition) => {
  const first = definition.steps[0];
  const assignment = first === undefined ? undefined : workflow.defaultAssignments[first.id];
  return (
    assignment !== undefined && (assignment.assignee !== null || assignment.automations.length > 0)
  );
};

/** A workflow must retain an active admin when its administrators change. */
export const lastAdminRefusal = (activeAdminIds: ReadonlyArray<string>) =>
  activeAdminIds.length === 0 ? ("last_admin" as const) : null;

/** Approval is a decision by the responsible person over an open ticket awaiting approval. */
export const stepApprovalRefusal = (actorId: string, ticket: Ticket, step: Step) =>
  ticket.status.type !== "open"
    ? "ticket_not_open"
    : step.status.type !== "waiting_approval"
      ? "step_not_actionable"
      : step.responsible !== actorId
        ? "not_step_responsible"
        : null;

/** Every required field and every sub-step must be complete before requesting approval. */
export const stepCompletionRefusal = (
  definition: StepDefinition | null,
  ticket: Ticket,
  step: Step,
) =>
  !fieldsComplete(definition?.fields ?? [], step.values) ||
  ticket.steps.some((child) => child.parentStepId === step.id && child.status.type !== "completed")
    ? ("step_incomplete" as const)
    : null;

const decodeDateFieldValue = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);
const fieldValueValidators = {
  text: Schema.is(Schema.String),
  number: Schema.is(Schema.Finite),
  boolean: Schema.is(Schema.Boolean),
  date: (value: unknown) => Option.isSome(decodeDateFieldValue(value)),
  file: Schema.is(AttachmentId),
};

/** Checks stored JSON against the field's meaning, before attachment access checks or writes. */
export const fieldValueRefusal = (field: StepField, value: Schema.Json) => {
  const valid =
    field.type === "select"
      ? typeof value === "string" && field.options.includes(value)
      : field.type === "group"
        ? field.repeatable && isRowIds(value)
        : fieldValueValidators[field.type](value);
  return valid ? null : ("invalid_field_value" as const);
};

/** Resolved from current membership, never persisted as a second source of people. */
export const resolveResponsible = (
  workflow: Workflow,
  requested: string | null,
  activePeople: ReadonlySet<string>,
) => {
  const notices: Array<"names_deactivated" | "needs_responsible"> = [];
  if (requested !== null && requested !== workflow.responsible) {
    if (activePeople.has(requested)) return { responsible: requested, notices };
    notices.push("names_deactivated");
  }
  if (activePeople.has(workflow.responsible)) return { responsible: workflow.responsible, notices };
  notices.push("needs_responsible");
  return { responsible: workflow.adminUserIds.find((id) => activePeople.has(id)) ?? null, notices };
};

/** Clearing an assignment leaves it empty; only an unavailable assignee is replaced. */
export const resolveAssignee = (
  requested: string | null,
  responsible: string,
  canTakeWork: boolean,
) =>
  requested === null || canTakeWork
    ? { assignee: requested, namesDeactivated: false }
    : { assignee: responsible, namesDeactivated: true };

export const stepPeopleOnEntry = (
  workflow: Workflow,
  definition: StepDefinition,
  inherited: string | null,
) => {
  const defaults = workflow.defaultAssignments[definition.id];
  return { responsible: defaults?.responsible ?? null, assignee: defaults?.assignee ?? inherited };
};

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

export const ticketStartRefusal = (
  actor: WorkflowActor,
  workflow: Workflow,
  definition: WorkflowDefinition,
) => {
  const first = definition.steps[0];
  if (first === undefined) return "no_steps";
  if (workflow.isArchived) return "workflow_archived";
  if (!hasInitialWork(workflow, definition)) return "first_step_unassigned";
  return workflow.defaultAssignments[first.id]?.assignee === actor.id || oversees(actor, workflow)
    ? null
    : "cannot_start_ticket";
};

export const definitionChangeRefusal = (ticket: Ticket, steps: ReadonlyArray<StepDefinition>) =>
  ticket.steps.every((step) => fits(steps, ticket, step)) ? null : ("tickets_cannot_move" as const);

export const canUpdateDefinition = (actor: WorkflowActor, instances: ReadonlyArray<Workflow>) =>
  instances.every((workflow) => isAdmin(actor, workflow));

export const fieldPathSurvives = (definition: StepDefinition | null, path: string) =>
  resolveFieldPath(definition?.fields ?? [], path) !== null;

export const stepAfterDefinitionChange = (step: Step, definition: StepDefinition | null): Step => {
  const values = Object.fromEntries(
    Object.entries(step.values).filter(([path]) => fieldPathSurvives(definition, path)),
  );
  return { ...step, values };
};

/** Missing subtrees are entered together; completed parents retain their historical children. */
export const subStepsToEnter = (
  ticket: Ticket,
  parent: Step,
  definition: StepDefinition,
): ReadonlyArray<{ readonly parent: Step; readonly definition: StepDefinition }> => {
  if (parent.status.type === "completed") return [];
  return definition.subSteps.flatMap((child) => {
    const existing = ticket.steps.find(
      (step) => step.parentStepId === parent.id && step.stepDefinitionId === child.id,
    );
    return existing === undefined
      ? [{ parent, definition: child }]
      : subStepsToEnter(ticket, existing, child);
  });
};

export const needsWorkAfterDefinitionChange = (
  ticket: Ticket,
  step: Step,
  definition: StepDefinition | null,
) =>
  step.status.type === "waiting_approval" &&
  definition !== null &&
  stepCompletionRefusal(definition, ticket, step) !== null;
