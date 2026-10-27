import * as Schema from "effect/Schema";
import type { Task } from "./Task.ts";
import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { AttachmentId, StringId, TrimmedNonEmptyString } from "./primitives.ts";

/*
 * A WorkflowDefinition is a named, ordered set of `StepDefinition`s, each a unit of work.
 *
 * Workflows combine the flexibility of defining very different processes that fit the most diverse use cases and teams with proper accountability and automation.
 */

const isFieldPathSegment = Schema.isPattern(/^[A-Za-z0-9_-]+$/);

/** A field or row ID; dots separate these IDs in field paths. */
export const FieldPathSegment = StringId.check(isFieldPathSegment);

const hasDistinctIds = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length;

const FieldValueSchemas = {
  text: Schema.String,
  number: Schema.Finite,
  boolean: Schema.Boolean,
  date: Schema.DateTimeUtcFromString,
  file: AttachmentId,
};

const FieldBase = {
  id: StringId.withConstructorDefault.check(isFieldPathSegment),
  label: TrimmedNonEmptyString,
  /** What to put in it, shown under the label. */
  description: Schema.optionalKey(Schema.String),
};

export class TextField extends Schema.Class<TextField>("TextField")({
  ...FieldBase,
  type: Schema.Literal("text"),
}) {
  readonly schema = FieldValueSchemas.text;
}

export class NumberField extends Schema.Class<NumberField>("NumberField")({
  ...FieldBase,
  type: Schema.Literal("number"),
}) {
  readonly schema = FieldValueSchemas.number;
}

export class BooleanField extends Schema.Class<BooleanField>("BooleanField")({
  ...FieldBase,
  type: Schema.Literal("boolean"),
}) {
  readonly schema = FieldValueSchemas.boolean;
}

export class DateField extends Schema.Class<DateField>("DateField")({
  ...FieldBase,
  type: Schema.Literal("date"),
}) {
  readonly schema = FieldValueSchemas.date;
}

export class FileField extends Schema.Class<FileField>("FileStepField")({
  ...FieldBase,
  type: Schema.Literal("file"),
}) {
  readonly schema = FieldValueSchemas.file;
}

export class SelectField extends Schema.Class<SelectField>("SelectField")({
  ...FieldBase,
  type: Schema.Literal("select"),
  options: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
}) {
  readonly schema = Schema.Literals(this.options);
}

export class GroupField extends Schema.Class<GroupField>("GroupField")({
  ...FieldBase,
  type: Schema.Literal("group"),
  repeatable: Schema.Boolean,
  fields: Schema.Array(Schema.suspend((): Schema.Codec<StepField, StepFieldEncoded> => StepField)),
}) {}

export const StepField = Schema.Union([
  TextField,
  NumberField,
  BooleanField,
  DateField,
  FileField,
  SelectField,
  GroupField,
]);

export type StepField =
  | TextField
  | NumberField
  | BooleanField
  | DateField
  | FileField
  | SelectField
  | GroupField;

const fieldIdsAreDistinct = (fields: ReadonlyArray<StepField>): boolean =>
  hasDistinctIds(fields.map((field) => field.id)) &&
  fields.every((field) => field.type !== "group" || fieldIdsAreDistinct(field.fields));

interface GroupFieldEncoded {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly type: "group";
  readonly repeatable: boolean;
  readonly fields: ReadonlyArray<StepFieldEncoded>;
}

type StepFieldEncoded =
  | typeof TextField.Encoded
  | typeof NumberField.Encoded
  | typeof BooleanField.Encoded
  | typeof DateField.Encoded
  | typeof FileField.Encoded
  | typeof SelectField.Encoded
  | GroupFieldEncoded;

interface StepDefinitionEncoded {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly fields: ReadonlyArray<StepFieldEncoded>;
  readonly subSteps: ReadonlyArray<StepDefinitionEncoded>;
}

export class StepDefinition extends Schema.Class<StepDefinition>("StepDefinition")({
  id: StringId,
  name: TrimmedNonEmptyString,
  instructions: Schema.String,
  fields: Schema.Array(StepField).check(
    Schema.makeFilter(fieldIdsAreDistinct, { expected: "distinct field ids among siblings" }),
  ),
  /** Start with their parent, which can't be done until every one is approved. */
  subSteps: Schema.Array(
    Schema.suspend((): Schema.Codec<StepDefinition, StepDefinitionEncoded> => StepDefinition),
  ),
}) {}

const stepIds = (steps: ReadonlyArray<StepDefinition>): ReadonlyArray<string> =>
  steps.flatMap((step) => [step.id, ...stepIds(step.subSteps)]);

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
      Schema.makeFilter((steps: ReadonlyArray<StepDefinition>) => hasDistinctIds(stepIds(steps)), {
        expected: "distinct step ids, sub-steps included",
      }),
    ),
    archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
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
    isDefault: Schema.Boolean,
    isPublic: Schema.Boolean,
    archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

class PendingStatus extends Schema.Opaque<PendingStatus>()(
  Schema.Struct({
    type: Schema.Literal("pending"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

class WorkingStatus extends Schema.Opaque<WorkingStatus>()(
  Schema.Struct({
    type: Schema.Literal("working"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

class WaitingApprovalStatus extends Schema.Opaque<WaitingApprovalStatus>()(
  Schema.Struct({
    type: Schema.Literal("waiting_approval"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

class BlockedStatus extends Schema.Opaque<BlockedStatus>()(
  Schema.Struct({
    type: Schema.Literal("blocked"),
    at: Schema.DateTimeUtcFromString,
    reason: TrimmedNonEmptyString,
  }),
) {}

class RejectedStatus extends Schema.Opaque<RejectedStatus>()(
  Schema.Struct({
    type: Schema.Literal("rejected"),
    at: Schema.DateTimeUtcFromString,
    reason: TrimmedNonEmptyString,
  }),
) {}

class CompletedStatus extends Schema.Opaque<CompletedStatus>()(
  Schema.Struct({
    type: Schema.Literal("completed"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

const StepStatus = Schema.Union([
  PendingStatus,
  WorkingStatus,
  WaitingApprovalStatus,
  BlockedStatus,
  RejectedStatus,
  CompletedStatus,
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
    responsible: Schema.NullOr(StringId),
    /** The values assigned to the fields of the step */
    values: Schema.Record(Schema.String, Schema.Json).check(
      Schema.isPropertyNames(Schema.toType(TrimmedNonEmptyString)),
    ),
  }),
) {}

class OpenStatus extends Schema.Opaque<OpenStatus>()(
  Schema.Struct({
    type: Schema.Literal("open"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

class DoneStatus extends Schema.Opaque<DoneStatus>()(
  Schema.Struct({
    type: Schema.Literal("done"),
    at: Schema.DateTimeUtcFromString,
  }),
) {}

class CancelledStatus extends Schema.Opaque<CancelledStatus>()(
  Schema.Struct({
    type: Schema.Literal("cancelled"),
    at: Schema.DateTimeUtcFromString,
    reason: TrimmedNonEmptyString,
  }),
) {}

const TicketStatus = Schema.Union([OpenStatus, DoneStatus, CancelledStatus]);

/** A run of a workflow. Nobody owns a ticket: its steps are owned. */
const hasValidStepReferences = (ticket: {
  readonly steps: ReadonlyArray<Step>;
  readonly currentStepId: string | null;
}) => {
  const byId = new Map(ticket.steps.map((step) => [step.id, step]));
  if (byId.size !== ticket.steps.length) return false;
  if (ticket.currentStepId !== null && !byId.has(ticket.currentStepId)) return false;
  return ticket.steps.every((step) => {
    const seen = new Set([step.id]);
    let parentId = step.parentStepId;
    while (parentId !== null) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent === undefined) return false;
      parentId = parent.parentStepId;
    }
    return true;
  });
};

export class Ticket extends Schema.Opaque<Ticket>()(
  Schema.Struct({
    id: StringId,
    workflowId: StringId,
    title: TrimmedNonEmptyString,
    description: Schema.String,
    dueDate: Schema.NullOr(Schema.DateTimeUtcFromString),
    status: TicketStatus,
    steps: Schema.Array(Step),
    /** The step the ticket is in; null once done. */
    currentStepId: Schema.NullOr(StringId),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }).check(
    Schema.makeFilter(hasValidStepReferences, {
      expected:
        "unique steps with existing, acyclic parent references and a current step belonging to the ticket",
    }),
  ),
) {}

export class Comment extends Schema.Opaque<Comment>()(
  Schema.Struct({
    id: StringId,
    author: StringId,
    body: Schema.String,
    createdAt: Schema.DateTimeUtcFromString,
    stepId: StringId,
  }),
) {}

const REFUSALS = [
  "not_org_admin",
  "not_workflow_admin",
  "slug_taken",
  "responsible_required",
  "invalid_people_ref",
  "no_steps",
  "tickets_cannot_move",
  "archive_instead_of_delete",
  "last_admin",
  "not_overseer",
  "cannot_start_ticket",
  "first_step_unassigned",
  "not_step_responsible",
  "workflow_archived",
  "ticket_not_open",
  "step_not_actionable",
  "step_incomplete",
  "reason_required",
  "invalid_field_value",
  "invalid_attachment",
  "invalid_automations",
] as const;

export class Refused extends Schema.TaggedError<Refused>()("WorkflowRefused", {
  reason: Schema.Literals(REFUSALS),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_org_admin":
        return "Only organization admins can do that.";
      case "not_workflow_admin":
        return "Only the workflow's admins can do that.";
      case "slug_taken":
        return "Another workflow already has that slug.";
      case "responsible_required":
        return "Choose who is responsible: they approve steps without a responsible of their own.";
      case "invalid_people_ref":
        return "That person or agent can no longer be given work.";
      case "no_steps":
        return "The workflow has no steps yet.";
      case "tickets_cannot_move":
        return "Some open tickets are in, or have passed, a step you removed or moved. Restore it, or finish or cancel those tickets first.";
      case "archive_instead_of_delete":
        return "A workflow with tickets can't be deleted. Archive it instead.";
      case "last_admin":
        return "A workflow needs at least one active admin.";
      case "not_overseer":
        return "Only the workflow's responsible and admins can do that.";
      case "cannot_start_ticket":
        return "You can't start tickets in this workflow.";
      case "first_step_unassigned":
        return "Assign the first step before starting a ticket.";
      case "not_step_responsible":
        return "Only the step's responsible can do that.";
      case "workflow_archived":
        return "This workflow is archived.";
      case "ticket_not_open":
        return "This ticket is no longer open.";
      case "step_not_actionable":
        return "This step can't do that right now.";
      case "step_incomplete":
        return "Fill in every field and get every sub-step approved first.";
      case "reason_required":
        return "Give a reason.";
      case "invalid_field_value":
        return "That value doesn't fit the field.";
      case "invalid_automations":
        return "Choose available agents and distinct automation identities.";
      case "invalid_attachment":
        return "That file can't be attached here.";
    }
  }
}

export interface StepNode {
  readonly step: StepDefinition;
  readonly parentId: string | null;
}

const stepNodes = (
  steps: ReadonlyArray<StepDefinition>,
  parentId: string | null = null,
): ReadonlyArray<StepNode> =>
  steps.flatMap((step) => [{ step, parentId }, ...stepNodes(step.subSteps, step.id)]);

export const findStep = (steps: ReadonlyArray<StepDefinition>, id: string): StepNode | null =>
  stepNodes(steps).find((node) => node.step.id === id) ?? null;

type Values = Step["values"];

const holdsData = (value: Schema.Json | undefined): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim() !== "") &&
  (!Array.isArray(value) || value.length > 0);

export const GroupRowIds = Schema.UniqueArray(FieldPathSegment);
const isRowIds = Schema.is(GroupRowIds);

export const rowIds = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  isRowIds(value) ? value : [];

export const groupRows = (field: StepField, value: Schema.Json | undefined) =>
  field.type === "group" && field.repeatable ? rowIds(value) : [null];

export const withinField = (path: string, id: string) => path === id || path.startsWith(`${id}.`);

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

const missingFields = (
  fields: ReadonlyArray<StepField>,
  values: Values,
  prefix = "",
  namePrefix = "",
): ReadonlyArray<{ readonly key: string; readonly name: string }> =>
  fields.flatMap((field) => {
    const path = prefix ? `${prefix}.${field.id}` : field.id;
    const name = `${namePrefix}${field.label}`;
    if (field.type !== "group") return holdsData(values[path]) ? [] : [{ key: path, name }];
    const rows = groupRows(field, values[path]);
    if (rows.length === 0) return [{ key: path, name }];
    return rows.flatMap((rowId, at) =>
      missingFields(
        field.fields,
        values,
        rowId === null ? path : `${path}.${rowId}`,
        field.repeatable ? `${name} › Entry ${at + 1} › ` : `${name} › `,
      ),
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

export const canStart = (
  actor: WorkflowActor,
  {
    workflow,
    definition,
  }: { readonly workflow: Workflow; readonly definition: WorkflowDefinition },
) =>
  hasInitialWork(workflow, definition) &&
  (workflow.defaultAssignments[definition.steps[0]!.id]?.assignee === actor.id ||
    oversees(actor, workflow));

/** A workflow must retain an active admin when its administrators change. */
export const lastAdminRefusal = (activeAdminIds: ReadonlyArray<string>) =>
  activeAdminIds.length === 0 ? ("last_admin" as const) : null;

/** Approval is a decision by the responsible person over an open ticket awaiting approval. */
export const stepApprovalRefusal = (
  actorId: string,
  workflow: Workflow,
  ticket: Ticket,
  step: Step,
) =>
  ticket.status.type !== "open"
    ? "ticket_not_open"
    : step.status.type !== "waiting_approval"
      ? "step_not_actionable"
      : stepApprover(workflow, step) !== actorId
        ? "not_step_responsible"
        : null;

/** Every required field and every sub-step must be complete before requesting approval. */
export const stepCompletionRefusal = (
  definition: StepDefinition | null,
  ticket: Ticket,
  step: Step,
) =>
  (definition !== null && missingFields(definition.fields, step.values).length > 0) ||
  ticket.steps.some((child) => child.parentStepId === step.id && child.status.type !== "completed")
    ? ("step_incomplete" as const)
    : null;

const decodeDateFieldValue = Schema.decodeUnknownOption(FieldValueSchemas.date);
const fieldValueValidators = {
  text: Schema.is(FieldValueSchemas.text),
  number: Schema.is(FieldValueSchemas.number),
  boolean: Schema.is(FieldValueSchemas.boolean),
  date: (value: unknown) => Option.isSome(decodeDateFieldValue(value)),
  file: Schema.is(FieldValueSchemas.file),
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

export const withStepPeople = (step: Step, responsible: string, assignee: string | null): Step =>
  responsible === step.responsible && assignee === step.assignee
    ? step
    : { ...step, responsible, assignee };

export const stepApprover = (workflow: Workflow, step: Step) =>
  step.responsible ?? workflow.responsible;

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

/** The server supplies identity, time, and people resolved from current membership. */
export const createStep = (
  definition: StepDefinition,
  id: string,
  at: DateTime.Utc,
  parentStepId: string | null,
  assignee: string | null,
  responsible: string,
  automations: ReadonlyArray<StepAutomation> = [],
): Step => ({
  id,
  stepDefinitionId: definition.id,
  parentStepId,
  status: { type: "working", at },
  assignee,
  responsible,
  values: {},
  automations,
});

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
    ticket:
      next === null
        ? { ...completed, status: { type: "done" as const, at }, currentStepId: null }
        : completed,
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
  if (workflow.archivedAt !== null) return "workflow_archived";
  if (!hasInitialWork(workflow, definition)) return "first_step_unassigned";
  return canStart(actor, { workflow, definition }) ? null : "cannot_start_ticket";
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
  return Object.keys(values).length === Object.keys(step.values).length
    ? step
    : { ...step, values };
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

export const responsibleChangeRefusal = (
  actor: WorkflowActor,
  workflow: Workflow,
  ticket: Ticket,
  step: Step,
) =>
  ticket.status.type !== "open"
    ? "ticket_not_open"
    : !oversees(actor, workflow) && step.responsible !== actor.id
      ? "not_overseer"
      : step.status.type === "completed"
        ? "step_not_actionable"
        : null;

export const workflowAdminDeactivationRefusal = (
  workflow: Workflow,
  userId: string,
  activeAdmins: ReadonlyArray<string>,
) =>
  workflow.adminUserIds.includes(userId) &&
  lastAdminRefusal(activeAdmins.filter((id) => id !== userId)) !== null
    ? ("last_workflow_admin" as const)
    : null;
