import { Task, TaskExecution } from "../models/Task.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Attachment, AttachmentId } from "../models/Attachment.ts";
import { StringId, TrimmedNonEmptyString } from "../models/primitives.ts";

import {
  Comment,
  FieldPathSegment,
  Refused as WorkflowRefused,
  Slug,
  Step,
  StepDefinition,
  StepField,
  Ticket,
  Workflow,
  WorkflowDefinition,
} from "../models/Workflow.ts";
import { NotFound } from "./errors.ts";

export const WorkflowErrors = Schema.Union([WorkflowRefused, NotFound]);

const WorkflowInstance = { workflow: Workflow, definition: WorkflowDefinition };

export const WorkflowInstanceView = Schema.Struct(WorkflowInstance);
export type WorkflowInstanceView = typeof WorkflowInstanceView.Type;

/** A workflow in the Workflows list; `canManage` is false for its responsible, who only oversees. */
export const WorkflowInstanceListEntryView = Schema.Struct({
  ...WorkflowInstance,
  canManage: Schema.Boolean,
});
export type WorkflowInstanceListEntryView = typeof WorkflowInstanceListEntryView.Type;

const workflow = { workflowId: StringId };
const idOrSlug = { idOrSlug: TrimmedNonEmptyString };

export const WorkflowDefinitionView = Schema.Struct({
  definition: WorkflowDefinition,
  canManage: Schema.Boolean,
});
export type WorkflowDefinitionView = typeof WorkflowDefinitionView.Type;

/** A step without its values. */
export const StepSummaryView = Schema.Struct(
  Struct.pick(Step.fields, [
    "id",
    "stepDefinitionId",
    "parentStepId",
    "status",
    "assignee",
    "responsible",
  ]),
);
export type StepSummaryView = typeof StepSummaryView.Type;

/** A ticket with the step it is in, and none of its values. */
export const TicketSummaryView = Schema.Struct({
  ...Struct.pick(Ticket.fields, ["id", "workflowId", "title", "dueDate", "status"]),
  currentStep: Schema.NullOr(StepSummaryView),
});
export type TicketSummaryView = typeof TicketSummaryView.Type;

export const WorkflowInstanceBoardView = Schema.Struct({
  ...WorkflowInstance,
  tickets: Schema.Array(TicketSummaryView),
});
export type WorkflowInstanceBoardView = typeof WorkflowInstanceBoardView.Type;

const ticket = { ticketId: StringId };
const step = { stepId: StringId };
const reason = { ...step, reason: Schema.String };

export const StepFileView = Schema.Struct(Struct.pick(Attachment.fields, ["id", "name"]));
export type StepFileView = typeof StepFileView.Type;

/**
 * A field as a step shows it. `key` is the field's path, which sets its value: a field inside a
 * group is `group.field`, and inside a repeatable group's row `group.rowId.field`.
 */
export class FieldView extends Schema.Opaque<FieldView>()(
  Schema.Struct({
    key: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
    description: Schema.String,
    type: Schema.Union(StepField.members.map((member) => member.fields.type)),
    /** A select field's choices, else empty. */
    options: Schema.Array(Schema.String),
    value: Schema.Json,
    repeatable: Schema.Boolean,
    file: Schema.NullOr(StepFileView),
    /** A group's rows: one with a null id for a group that doesn't repeat. Empty for other fields. */
    rows: Schema.Array(
      Schema.Struct({
        id: Schema.NullOr(FieldPathSegment),
        fields: Schema.Array(Schema.suspend((): Schema.Codec<FieldView> => FieldView)),
      }),
    ),
  }),
) {}

/** A step another step's view names; it opens as a step of its own. */
export const StepNameView = Schema.Struct({ id: StringId, name: TrimmedNonEmptyString });
export type StepNameView = typeof StepNameView.Type;

/** One step, with the names of the steps it sits in and of its sub-steps. */
export const StepView = Schema.Struct({
  ticket: Schema.Struct(Struct.omit(Ticket.fields, ["steps"])),
  workflowName: TrimmedNonEmptyString,
  otherSteps: Schema.Array(
    Schema.Struct({ step: StepSummaryView, name: Schema.String, fields: Schema.Array(FieldView) }),
  ),
  step: Step,
  /** Null once the workflow no longer has the step. */
  definition: Schema.NullOr(
    Schema.Struct(Struct.pick(StepDefinition.fields, ["name", "instructions"])),
  ),
  /** The steps a sub-step sits in, outermost first; empty for a step. */
  parents: Schema.Array(StepNameView),
  /** Whether the current user may open the workflow's board: its admins and its responsible. */
  canOpenBoard: Schema.Boolean,
  canRunAutomations: Schema.Boolean,
  fields: Schema.Array(FieldView),
  subSteps: Schema.Array(Schema.Struct({ ...StepSummaryView.fields, name: TrimmedNonEmptyString })),
  comments: Schema.Array(Comment),
  files: Schema.Array(StepFileView),
  tasks: Schema.Array(Schema.Struct({ ...Task.fields, execution: TaskExecution })),
});
export type StepView = typeof StepView.Type;

export const Workflows = RpcGroup.make(
  Rpc.make("listDefinitions", { success: Schema.Array(WorkflowDefinition), error: WorkflowErrors }),
  Rpc.make("getDefinition", {
    payload: { definitionId: StringId },
    success: WorkflowDefinitionView,
    error: WorkflowErrors,
  }),
  Rpc.make("listInstances", {
    success: Schema.Array(WorkflowInstanceListEntryView),
    error: WorkflowErrors,
  }),
  Rpc.make("listStartableInstances", {
    success: Schema.Array(Workflow),
    error: WorkflowErrors,
  }),
  Rpc.make("getInstance", {
    payload: idOrSlug,
    success: WorkflowInstanceView,
    error: WorkflowErrors,
  }),
  Rpc.make("getInstanceBoard", {
    payload: idOrSlug,
    success: WorkflowInstanceBoardView,
    error: WorkflowErrors,
  }),
  Rpc.make("createDefinition", {
    payload: {
      name: TrimmedNonEmptyString,
      /** Checked like saved ones; omitted, the definition starts with no steps. */
      steps: Schema.optionalKey(WorkflowDefinition.fields.steps),
    },
    success: Schema.Struct({ definitionId: StringId }),
    error: WorkflowErrors,
  }),
  Rpc.make("createInstance", {
    payload: {
      definitionId: StringId,
      /** Omitted, the definition's name. */
      name: Schema.optionalKey(TrimmedNonEmptyString),
      responsible: Workflow.fields.responsible,
    },
    success: Schema.Struct(workflow),
    error: WorkflowErrors,
  }),
  /** Omitted fields are left unchanged. */
  Rpc.make("updateDefinition", {
    payload: {
      definitionId: StringId,
      name: Schema.optionalKey(WorkflowDefinition.fields.name),
      /**
       * Replaces the steps. Open tickets of every workflow using the definition move onto them at the
       * step they are in; refused with `tickets_cannot_move` when a step a ticket is in, or has
       * entered, is removed or moved.
       */
      steps: Schema.optionalKey(WorkflowDefinition.fields.steps),
      isArchived: Schema.optionalKey(Schema.Boolean),
    },
    error: WorkflowErrors,
  }),
  /** Omitted fields are left unchanged. */
  Rpc.make("updateInstance", {
    payload: {
      ...workflow,
      name: Schema.optionalKey(TrimmedNonEmptyString),
      responsible: Schema.optionalKey(Workflow.fields.responsible),
      /** Refused with `slug_taken` when another workflow has it; null clears it. */
      slug: Schema.optionalKey(Schema.NullOr(Slug)),
      isPublic: Schema.optionalKey(Workflow.fields.isPublic),
      defaultAssignments: Schema.optionalKey(Workflow.fields.defaultAssignments),
      /** Refused with `last_admin` when it leaves no active admin. */
      adminUserIds: Schema.optionalKey(Workflow.fields.adminUserIds),
      isArchived: Schema.optionalKey(Schema.Boolean),
    },
    error: WorkflowErrors,
  }),
  Rpc.make("deleteInstance", { payload: workflow, error: WorkflowErrors }),
  Rpc.make("startTicket", {
    payload: {
      ...workflow,
      title: TrimmedNonEmptyString,
      description: Schema.optionalKey(Schema.String),
    },
    success: Schema.Struct(step),
    error: WorkflowErrors,
  }),
  Rpc.make("cancelTicket", {
    payload: { ...ticket, reason: Schema.String },
    error: WorkflowErrors,
  }),
  Rpc.make("reopenTicket", { payload: ticket, error: WorkflowErrors }),
  Rpc.make("setTicketDueDate", {
    payload: { ...ticket, dueDate: Ticket.fields.dueDate },
    error: WorkflowErrors,
  }),
  Rpc.make("getStep", { payload: step, success: StepView, error: WorkflowErrors }),
  Rpc.make("watchStep", { payload: step, success: StepView, error: WorkflowErrors, stream: true }),
  Rpc.make("setStepField", {
    payload: { ...step, fieldKey: TrimmedNonEmptyString, value: Schema.Json },
    error: WorkflowErrors,
  }),
  Rpc.make("markStepDone", { payload: step, error: WorkflowErrors }),
  Rpc.make("approveStep", { payload: step, error: WorkflowErrors }),
  Rpc.make("rejectStep", { payload: reason, error: WorkflowErrors }),
  Rpc.make("setStepAutomations", {
    payload: { ...step, automations: Step.fields.automations },
    error: WorkflowErrors,
  }),
  Rpc.make("runStepAutomation", {
    payload: { ...step, automationId: StringId },
    error: WorkflowErrors,
  }),
  Rpc.make("stopStepAutomation", {
    payload: { ...step, automationId: StringId },
    error: WorkflowErrors,
  }),
  /** Sets one ticket's step assignee; null clears it. */
  Rpc.make("setStepAssignee", {
    payload: { ...step, assignee: Step.fields.assignee },
    error: WorkflowErrors,
  }),
  Rpc.make("blockStep", { payload: reason, error: WorkflowErrors }),
  Rpc.make("unblockStep", { payload: step, error: WorkflowErrors }),
  Rpc.make("commentOnStep", {
    payload: { ...step, body: TrimmedNonEmptyString },
    error: WorkflowErrors,
  }),
  Rpc.make("attachStepFile", {
    payload: {
      ...step,
      attachmentId: AttachmentId,
      fieldKey: Schema.optionalKey(TrimmedNonEmptyString),
    },
    error: WorkflowErrors,
  }),
  Rpc.make("removeStepFile", {
    payload: { ...step, attachmentId: AttachmentId },
    error: WorkflowErrors,
  }),
).prefix("workflows.");
