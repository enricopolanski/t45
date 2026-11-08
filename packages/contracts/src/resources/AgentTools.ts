import * as Schema from "effect/Schema";

import { WORKFLOW_DRAFTING_MCP_NAME } from "../models/Agent.ts";
import { WorkflowDefinition } from "../models/Workflow.ts";
import { StringId, TrimmedNonEmptyString } from "../models/primitives.ts";

/**
 * The `draft` tool of `WORKFLOW_DRAFTING_MCP` as OpenCode names it, and what that takes: a name and the steps. The chat shows the draft for the member to create.
 */
export const WORKFLOW_DRAFT_TOOL_NAME = `${WORKFLOW_DRAFTING_MCP_NAME}_draft`;

export const WorkflowDraft = Schema.Struct({
  name: WorkflowDefinition.fields.name,
  steps: WorkflowDefinition.fields.steps,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

// The request ID survives a retry and also names its reply file in the sandbox.
const requestId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u));

/**
 * A step tool call T45 applies, decoded from the tool's name as OpenCode shows it (the tools of
 * `STEP_TOOLS_MCP`, called directly) and the call's input.
 */
export const StepToolCall = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("step_set_field"),
    input: Schema.Struct({
      requestId,
      fieldKey: TrimmedNonEmptyString,
      value: Schema.Json,
    }),
  }),
  Schema.Struct({
    tool: Schema.Literal("step_comment"),
    input: Schema.Struct({ requestId, body: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    tool: Schema.Literal("step_attach"),
    input: Schema.Struct({
      requestId,
      path: Schema.String,
      fieldKey: Schema.optionalKey(Schema.String),
    }),
  }),
]);
export type StepToolCall = typeof StepToolCall.Type;

export const WorkflowInstanceInputs = {
  get_workflow: Schema.Struct({ requestId }),
  list_tickets: Schema.Struct({ requestId, query: Schema.optionalKey(Schema.String) }),
  get_ticket: Schema.Struct({ requestId, ticketId: StringId }),
  create_ticket: Schema.Struct({
    requestId,
    title: TrimmedNonEmptyString,
    description: Schema.optionalKey(Schema.String),
  }),
  set_field: Schema.Struct({
    requestId,
    stepId: StringId,
    fieldKey: TrimmedNonEmptyString,
    value: Schema.Json,
  }),
};
export const WorkflowInstanceCall = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("get_workflow"),
    input: WorkflowInstanceInputs.get_workflow,
  }),
  Schema.Struct({
    tool: Schema.Literal("list_tickets"),
    input: WorkflowInstanceInputs.list_tickets,
  }),
  Schema.Struct({ tool: Schema.Literal("get_ticket"), input: WorkflowInstanceInputs.get_ticket }),
  Schema.Struct({
    tool: Schema.Literal("create_ticket"),
    input: WorkflowInstanceInputs.create_ticket,
  }),
  Schema.Struct({ tool: Schema.Literal("set_field"), input: WorkflowInstanceInputs.set_field }),
]);
export type WorkflowInstanceCall = typeof WorkflowInstanceCall.Type;
export const WorkflowToolResponse = Schema.Struct({
  call: Schema.Union([WorkflowInstanceCall, StepToolCall]),
  text: Schema.String,
  isError: Schema.Boolean,
});
