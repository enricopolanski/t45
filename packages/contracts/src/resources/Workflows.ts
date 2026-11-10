import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { AutomationId } from "../models/Automation.ts";
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
  Project,
  Workflow,
} from "../models/Workflow.ts";
import { Refused as ChatRefused } from "../models/Chat.ts";
import { AccessDenied, NotFound } from "./errors.ts";

export const WorkflowErrors = Schema.Union([WorkflowRefused, NotFound, AccessDenied]);

const ProjectWithWorkflow = { project: Project, workflow: Workflow };

export const ProjectView = Schema.Struct(ProjectWithWorkflow);
export type ProjectView = typeof ProjectView.Type;

/** A project in the Projects list; `canManage` is false for its responsible, who only oversees. */
export const ProjectListEntryView = Schema.Struct({
  ...ProjectWithWorkflow,
  canManage: Schema.Boolean,
});
export type ProjectListEntryView = typeof ProjectListEntryView.Type;

const project = { projectId: StringId };
const idOrSlug = { idOrSlug: TrimmedNonEmptyString };

export const WorkflowView = Schema.Struct({
  workflow: Workflow,
  canManage: Schema.Boolean,
});
export type WorkflowView = typeof WorkflowView.Type;

/** A step without its values. */
export const StepSummaryView = Schema.Struct(
  Struct.pick(Step.fields, ["id", "stepDefinitionId", "parentStepId", "status", "assignee"]),
);
export type StepSummaryView = typeof StepSummaryView.Type;

/** A ticket with the step it is in, and none of its values. */
export const TicketSummaryView = Schema.Struct({
  ...Struct.pick(Ticket.fields, ["id", "projectId", "title", "dueDate", "status"]),
  currentStep: Schema.NullOr(StepSummaryView),
});
export type TicketSummaryView = typeof TicketSummaryView.Type;

export const ProjectBoardView = Schema.Struct({
  ...ProjectWithWorkflow,
  tickets: Schema.Array(TicketSummaryView),
});
export type ProjectBoardView = typeof ProjectBoardView.Type;

const ticket = { ticketId: StringId };
const step = { stepId: StringId };

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
  projectName: TrimmedNonEmptyString,
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
  /** Whether the current user may open the project's board: its admins and its responsible. */
  canOpenBoard: Schema.Boolean,
  fields: Schema.Array(FieldView),
  subSteps: Schema.Array(Schema.Struct({ ...StepSummaryView.fields, name: TrimmedNonEmptyString })),
  comments: Schema.Array(Comment),
  files: Schema.Array(StepFileView),
  automations: Schema.Array(
    Schema.Struct({
      id: StringId,
      statusLabel: Schema.String,
      runLabel: Schema.NullOr(Schema.Literals(["Run", "Run again"])),
      canStop: Schema.Boolean,
    }),
  ),
});
export type StepView = typeof StepView.Type;

export const Workflows = RpcGroup.make(
  Rpc.make("listWorkflows", { success: Schema.Array(Workflow), error: WorkflowErrors }),
  Rpc.make("getWorkflow", {
    payload: { workflowId: StringId },
    success: WorkflowView,
    error: WorkflowErrors,
  }),
  Rpc.make("listProjects", {
    success: Schema.Array(ProjectListEntryView),
    error: WorkflowErrors,
  }),
  Rpc.make("listStartableProjects", {
    success: Schema.Array(Project),
    error: WorkflowErrors,
  }),
  Rpc.make("getProject", {
    payload: idOrSlug,
    success: ProjectView,
    error: WorkflowErrors,
  }),
  Rpc.make("getProjectBoard", {
    payload: idOrSlug,
    success: ProjectBoardView,
    error: WorkflowErrors,
  }),
  Rpc.make("createWorkflow", {
    payload: {
      name: TrimmedNonEmptyString,
      /** Checked like saved ones; omitted, the workflow starts with no steps. */
      steps: Schema.optionalKey(Workflow.fields.steps),
    },
    success: Schema.Struct({ workflowId: StringId }),
    error: WorkflowErrors,
  }),
  Rpc.make("createProject", {
    payload: {
      workflowId: StringId,
      /** Omitted, the workflow's name. */
      name: Schema.optionalKey(TrimmedNonEmptyString),
      responsible: Project.fields.responsible,
    },
    success: Schema.Struct(project),
    error: WorkflowErrors,
  }),
  /** Omitted fields are left unchanged. */
  Rpc.make("updateWorkflow", {
    payload: {
      workflowId: StringId,
      name: Schema.optionalKey(Workflow.fields.name),
      /**
       * Replaces the steps. Open tickets of every project using the workflow move onto them at the
       * step they are in; refused with `tickets_cannot_move` when a step a ticket is in, or has
       * entered, is removed or moved.
       */
      steps: Schema.optionalKey(Workflow.fields.steps),
      isArchived: Schema.optionalKey(Schema.Boolean),
    },
    error: WorkflowErrors,
  }),
  /** Omitted fields are left unchanged. */
  Rpc.make("updateProject", {
    payload: {
      ...project,
      name: Schema.optionalKey(TrimmedNonEmptyString),
      responsible: Schema.optionalKey(Project.fields.responsible),
      /** Refused with `slug_taken` when another project has it; null clears it. */
      slug: Schema.optionalKey(Schema.NullOr(Slug)),
      isPublic: Schema.optionalKey(Project.fields.isPublic),
      defaultAssignments: Schema.optionalKey(Project.fields.defaultAssignments),
      /** Refused with `last_admin` when it leaves no active admin. */
      adminUserIds: Schema.optionalKey(Project.fields.adminUserIds),
      isArchived: Schema.optionalKey(Schema.Boolean),
    },
    error: WorkflowErrors,
  }),
  Rpc.make("deleteProject", { payload: project, error: WorkflowErrors }),
  Rpc.make("getProjectWorkflow", {
    payload: project,
    success: Schema.Struct({
      projectId: StringId,
      name: Schema.String,
      workflow: Workflow,
    }),
    error: WorkflowErrors,
  }),
  Rpc.make("listTickets", {
    payload: { ...project, query: Schema.optionalKey(Schema.String) },
    success: Schema.Struct({
      total: Schema.Number,
      tickets: Schema.Array(
        Schema.Struct({
          ...Struct.pick(Ticket.fields, ["id", "title", "status"]),
          steps: Schema.Array(
            Schema.Struct(Struct.pick(Step.fields, ["id", "stepDefinitionId", "status"])),
          ),
        }),
      ),
    }),
    error: WorkflowErrors,
  }),
  Rpc.make("getTicket", {
    payload: ticket,
    success: Ticket,
    error: WorkflowErrors,
  }),
  Rpc.make("startTicket", {
    payload: {
      ...project,
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
  Rpc.make("watchStep", { payload: step, success: StepView, error: WorkflowErrors, stream: true }),
  Rpc.make("setStepField", {
    payload: { ...step, fieldKey: TrimmedNonEmptyString, value: Schema.Json },
    error: WorkflowErrors,
  }),
  Rpc.make("markStepDone", { payload: step, error: WorkflowErrors }),
  Rpc.make("setStepAutomations", {
    payload: { ...step, automationIds: Step.fields.automationIds },
    error: WorkflowErrors,
  }),
  Rpc.make("runStepAutomation", {
    payload: { ...step, automationId: AutomationId },
    error: Schema.Union([WorkflowErrors, ChatRefused]),
  }),
  Rpc.make("stopStepAutomation", {
    payload: { ...step, automationId: AutomationId },
    error: WorkflowErrors,
  }),
  /** Sets one ticket's step assignee; null clears it. */
  Rpc.make("setStepAssignee", {
    payload: { ...step, assignee: Step.fields.assignee },
    error: WorkflowErrors,
  }),
  Rpc.make("blockStep", { payload: { ...step, reason: Schema.String }, error: WorkflowErrors }),
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
