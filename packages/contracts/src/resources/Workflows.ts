import { Session } from "@opencode/schema/session";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { AutomationId } from "../models/Automation.ts";
import { ChatId, Report } from "../models/Chat.ts";
import { RunStatus } from "../models/ChatOrigin.ts";
import { Attachment, AttachmentId } from "../models/Attachment.ts";
import { StringId, TrimmedNonEmptyString } from "../models/primitives.ts";
import { Field, FieldPathSegment } from "../models/Field.ts";

import {
  Comment,
  Refused as WorkflowRefused,
  Slug,
  Step,
  StepDefinition,
  Ticket,
  Project,
  Workflow,
  WorkflowEdit,
  WorkflowVersion,
} from "../models/Workflow.ts";
import { Refused as ChatRefused } from "../models/Chat.ts";
import { AccessDenied, NotFound } from "./errors.ts";

export const WorkflowErrors = Schema.Union([WorkflowRefused, NotFound, AccessDenied]);

/** What a field is set to: text (including URLs), a number, yes/no, row ids, or nothing. */
export const FieldValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String),
  Schema.Null,
]);
export type FieldValue = typeof FieldValue.Type;

const ProjectWithWorkflow = { project: Project, workflow: Workflow };

const project = { projectId: StringId };

/** One member of one of the workflow's steps in a project; `stepId` is the step's definition id. */
const stepMember = { ...project, stepId: StringId, userId: StringId };

/**
 * A project as those who manage it set it up. They see its structure and people, and of its
 * tickets only what identifies them: no description, no step content.
 */
export const ProjectView = Schema.Struct({
  ...ProjectWithWorkflow,
  /** The version new tickets start on; null before the first adoption. */
  adopted: Schema.NullOr(WorkflowVersion),
  /** The workflow's newest version, which the project can adopt. */
  latest: WorkflowVersion,
  /** Who works on each of the workflow's steps; sub-steps have their step's members. */
  members: Schema.Array(Schema.Struct(Struct.pick(stepMember, ["stepId", "userId"]))),
  openTickets: Schema.Array(Schema.Struct(Struct.pick(Ticket.fields, ["id", "title", "status"]))),
  /** Whether the viewer is one of the project's listed admins, who alone cancel its tickets. */
  canCancelTickets: Schema.Boolean,
});
export type ProjectView = typeof ProjectView.Type;

const idOrSlug = { idOrSlug: TrimmedNonEmptyString };

/** A workflow with its newest version: the draft a save changes, or the frozen one it follows. */
export const WorkflowView = Schema.Struct({
  workflow: Workflow,
  version: WorkflowVersion,
  canEdit: Schema.Boolean,
  canSetEditors: Schema.Boolean,
});
export type WorkflowView = typeof WorkflowView.Type;

const VersionNameView = Schema.Struct(Struct.pick(WorkflowVersion.fields, ["id", "number"]));

/** A version as the caller read it, so that a save or an adoption of an older draft is refused. */
const versionRead = { versionId: StringId, revision: WorkflowVersion.fields.revision };

/** A step without its values. */
export const StepSummaryView = Schema.Struct(
  Struct.pick(Step.fields, ["id", "stepDefinitionId", "parentStepId", "status", "assignee"]),
);
export type StepSummaryView = typeof StepSummaryView.Type;

/** A ticket with the step it is in, and none of its values. */
export const TicketSummaryView = Schema.Struct({
  ...Struct.pick(Ticket.fields, ["id", "projectId", "title", "status"]),
  currentStep: Schema.NullOr(StepSummaryView),
});
export type TicketSummaryView = typeof TicketSummaryView.Type;

/** A step another step's view names; it opens as a step of its own. */
export const StepNameView = Schema.Struct({ id: StringId, name: TrimmedNonEmptyString });
export type StepNameView = typeof StepNameView.Type;

/**
 * The open tickets of one version of a project's workflow, under that version's steps: only the
 * steps the viewer is a member of, and the tickets in them.
 */
export const ProjectBoardView = Schema.Struct({
  project: Schema.Struct(Struct.pick(Project.fields, ["id", "name", "slug", "isArchived"])),
  version: VersionNameView,
  /** The viewer's steps of the version, each named by its definition's id. */
  columns: Schema.Array(StepNameView),
  /** The adopted version, and the others while they have open tickets the viewer sees. */
  versions: Schema.Array(VersionNameView),
  tickets: Schema.Array(TicketSummaryView),
  canStartTicket: Schema.Boolean,
});
export type ProjectBoardView = typeof ProjectBoardView.Type;

const ticket = { ticketId: StringId };
const step = { stepId: StringId };

/** The file a field holds. */
const FieldFileView = Schema.Struct(Struct.pick(Attachment.fields, ["id", "name"]));

/** A step's file: who added it and when. */
const StepFileView = Schema.Struct(
  Struct.pick(Attachment.fields, ["id", "name", "uploader", "createdAt"]),
);

/**
 * A field as a step shows it. `key` is the field's path, which sets its value: a field inside a
 * group is `group.field`, and inside a repeatable group's row `group.rowId.field`.
 */
export class FieldView extends Schema.Opaque<FieldView>()(
  Schema.Struct({
    key: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
    description: Schema.String,
    type: Schema.Union(Field.members.map((member) => member.fields.type)),
    /** A select field's choices, else empty. */
    options: Schema.Array(Schema.String),
    value: Schema.Json,
    repeatable: Schema.Boolean,
    file: Schema.NullOr(FieldFileView),
    /**
     * A repeatable group's row fields as its definition declares them, rows or not: a row's field
     * key is `group.rowId.id`. Empty for other fields.
     */
    rowFields: Schema.Array(Field),
    /** A group's rows: one with a null id for a group that doesn't repeat. Empty for other fields. */
    rows: Schema.Array(
      Schema.Struct({
        id: Schema.NullOr(FieldPathSegment),
        fields: Schema.Array(Schema.suspend((): Schema.Codec<FieldView> => FieldView)),
      }),
    ),
  }),
) {}

/**
 * One step as someone who may see it does, with the names of the steps it sits in and of its
 * sub-steps. Of the ticket's other steps it holds nothing, not even their names, but the fields
 * this step declares as inputs.
 */
export const StepView = Schema.Struct({
  ticket: Schema.Struct(Struct.omit(Ticket.fields, ["steps"])),
  projectName: TrimmedNonEmptyString,
  /**
   * The workflow's steps the ticket entered, for whoever sees a closed ticket whole; else just
   * the one this step is or sits in.
   */
  otherSteps: Schema.Array(
    Schema.Struct({ step: StepSummaryView, name: Schema.String, fields: Schema.Array(FieldView) }),
  ),
  /** The fields of earlier steps this step reads. */
  inputs: Schema.Array(FieldView),
  /** The active members of the step, who can be assigned to it. */
  assignableUserIds: Schema.Array(StringId),
  /** The commands run on this step, oldest first; a ticket's first step starts with its creation. */
  history: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      /** Who ran it, or on whose authority an agent did. */
      userId: Schema.NullOr(StringId),
      agentId: Schema.NullOr(StringId),
      fieldKey: Schema.NullOr(TrimmedNonEmptyString),
      automation: Schema.NullOr(Schema.Struct({ id: AutomationId, title: TrimmedNonEmptyString })),
      createdAt: Schema.DateTimeUtcFromString,
    }),
  ),
  canCancelTicket: Schema.Boolean,
  step: Step,
  definition: Schema.Struct(Struct.pick(StepDefinition.fields, ["name", "instructions"])),
  /** The steps a sub-step sits in, outermost first; empty for a step. */
  parents: Schema.Array(StepNameView),
  fields: Schema.Array(FieldView),
  subSteps: Schema.Array(Schema.Struct({ ...StepSummaryView.fields, name: TrimmedNonEmptyString })),
  comments: Schema.Array(Comment),
  files: Schema.Array(StepFileView),
  /** The automations the step's definition attaches, each with its latest run on this step. */
  automations: Schema.Array(
    Schema.Struct({
      id: AutomationId,
      /** Its runs on this step, newest first: who started each, when, and how it stands. */
      runs: Schema.Array(
        Schema.Struct({
          /** The chat it runs in. */
          chatId: ChatId,
          ranBy: StringId,
          startedAt: Schema.DateTimeUtcFromString,
          /** Null while it runs. */
          endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
          status: RunStatus,
          latestReport: Schema.NullOr(Report),
          /** What it used so far. */
          ...Struct.pick(Session.Info.fields, ["cost", "tokens"]),
        }),
      ),
      runLabel: Schema.NullOr(Schema.Literals(["Run", "Run again"])),
      canStop: Schema.Boolean,
    }),
  ),
});
export type StepView = typeof StepView.Type;

export const Workflows = RpcGroup.make(
  Rpc.make("listWorkflows", {
    success: Schema.Array(Schema.Struct({ workflow: Workflow, version: WorkflowVersion })),
    error: WorkflowErrors,
  }),
  Rpc.make("getWorkflow", {
    payload: { workflowId: StringId },
    success: WorkflowView,
    error: WorkflowErrors,
  }),
  /** The projects the caller manages. */
  Rpc.make("listProjects", {
    success: Schema.Array(Schema.Struct(ProjectWithWorkflow)),
    error: WorkflowErrors,
  }),
  /** The projects whose board the caller opens: those with a step they are a member of. */
  Rpc.make("listBoards", {
    success: Schema.Array(Schema.Struct(Struct.pick(Project.fields, ["id", "name", "slug"]))),
    error: WorkflowErrors,
  }),
  /** The projects whose first step the caller is a member of. */
  Rpc.make("listStartableProjects", {
    success: Schema.Array(Schema.Struct(Struct.pick(Project.fields, ["id", "name"]))),
    error: WorkflowErrors,
  }),
  Rpc.make("getProject", {
    payload: idOrSlug,
    success: ProjectView,
    error: WorkflowErrors,
  }),
  Rpc.make("getProjectBoard", {
    /** Omitted, the board of the project's adopted version. */
    payload: { ...idOrSlug, versionId: Schema.optionalKey(StringId) },
    success: ProjectBoardView,
    error: WorkflowErrors,
  }),
  /** The workflow starts as a draft of its first version, with the caller as its creator. */
  Rpc.make("createWorkflow", {
    payload: {
      name: TrimmedNonEmptyString,
      /** Applied to the empty draft; omitted, the workflow starts with no steps. */
      edits: Schema.optionalKey(Schema.Array(WorkflowEdit)),
    },
    success: Schema.Struct({ workflowId: StringId }),
    error: WorkflowErrors,
  }),
  /** Renames the workflow in place; no version changes. */
  Rpc.make("renameWorkflow", {
    payload: { workflowId: StringId, name: Workflow.fields.name },
    error: WorkflowErrors,
  }),
  Rpc.make("setWorkflowEditors", {
    payload: { workflowId: StringId, editorUserIds: Workflow.fields.editorUserIds },
    error: WorkflowErrors,
  }),
  /** For good: no new project uses the workflow and none adopts a version of it. */
  Rpc.make("archiveWorkflow", { payload: { workflowId: StringId }, error: WorkflowErrors }),
  /**
   * Applies the edits, in order, to the workflow's newest version: a draft is overwritten, and a
   * frozen version gets the next one as a draft. Refused with `stale_draft` unless `versionId` and
   * `revision` are that newest version as the caller read it.
   */
  Rpc.make("saveWorkflowDraft", {
    payload: { ...versionRead, edits: Schema.Array(WorkflowEdit) },
    error: WorkflowErrors,
  }),
  /** The project adopts no version yet: an admin does that once its people are chosen. */
  Rpc.make("createProject", {
    payload: {
      workflowId: StringId,
      /** Omitted, the workflow's name. */
      name: Schema.optionalKey(TrimmedNonEmptyString),
    },
    success: Schema.Struct(project),
    error: WorkflowErrors,
  }),
  /**
   * New tickets of the project start on this version of its workflow, which is frozen from now on;
   * tickets already started stay on theirs. Refused with `stale_draft` when the version was saved
   * after `revision`, and with `step_without_members` until each of its steps has an active member.
   */
  Rpc.make("adoptWorkflowVersion", {
    payload: {
      ...project,
      ...versionRead,
    },
    error: WorkflowErrors,
  }),
  /** Omitted fields are left unchanged. */
  Rpc.make("updateProject", {
    payload: {
      ...project,
      name: Schema.optionalKey(TrimmedNonEmptyString),
      /** Refused with `slug_taken` when another project has it; null clears it. */
      slug: Schema.optionalKey(Schema.NullOr(Slug)),
      defaultAssignees: Schema.optionalKey(Project.fields.defaultAssignees),
      /** Refused with `last_admin` when it leaves no active admin. */
      adminUserIds: Schema.optionalKey(Project.fields.adminUserIds),
    },
    error: WorkflowErrors,
  }),
  /**
   * For good: the project starts no new ticket, adopts no version and runs no automation on a
   * step, while its open tickets are worked to their end.
   */
  Rpc.make("archiveProject", { payload: project, error: WorkflowErrors }),
  /** Adding oneself is an entry of the command log like any other. */
  Rpc.make("addStepMember", { payload: stepMember, error: WorkflowErrors }),
  /** Refused with `member_assigned` while they are assigned to the step on an open ticket. */
  Rpc.make("removeStepMember", { payload: stepMember, error: WorkflowErrors }),
  /** The open tickets' steps that keep someone a member: those they are assigned to under the step. */
  Rpc.make("listStepAssignments", {
    payload: stepMember,
    success: Schema.Array(
      Schema.Struct({
        ticketTitle: Ticket.fields.title,
        stepId: StringId,
        stepName: TrimmedNonEmptyString,
      }),
    ),
    error: WorkflowErrors,
  }),
  /**
   * The project and, of its adopted version, the steps the caller is a member of, each without its
   * inputs: those would name the other steps.
   */
  Rpc.make("getProjectWorkflow", {
    payload: project,
    success: Schema.Struct({
      projectId: StringId,
      name: Schema.String,
      steps: WorkflowVersion.fields.steps,
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
  /** The ticket with only the steps the caller sees. */
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
  Rpc.make("watchStep", { payload: step, success: StepView, error: WorkflowErrors, stream: true }),
  /** The step as the web shows it, once; an automation reads its own step. */
  Rpc.make("getStep", { payload: step, success: StepView, error: WorkflowErrors }),
  Rpc.make("setStepField", {
    payload: { ...step, fieldKey: TrimmedNonEmptyString, value: FieldValue },
    error: WorkflowErrors,
  }),
  Rpc.make("markStepDone", { payload: step, error: WorkflowErrors }),
  Rpc.make("runStepAutomation", {
    payload: { ...step, automationId: AutomationId },
    error: Schema.Union([WorkflowErrors, ChatRefused]),
  }),
  Rpc.make("stopStepAutomation", {
    payload: { ...step, automationId: AutomationId },
    error: WorkflowErrors,
  }),
  /**
   * Sets one ticket's step assignee, a member of the step; null clears it. Those who manage the
   * project do it on any step of an open ticket, without seeing the step.
   */
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
