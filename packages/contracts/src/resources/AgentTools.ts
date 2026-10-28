import * as Schema from "effect/Schema";

import { WORKFLOW_DRAFTING_MCP_NAME } from "../models/Agent.ts";
import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { WorkflowDefinition } from "../models/Workflow.ts";

/**
 * The `draft` tool of `WORKFLOW_DRAFTING_MCP` as OpenCode names it, and what that takes: a name and the steps. The chat shows the draft for the member to create.
 */
export const WORKFLOW_DRAFT_TOOL_NAME = `${WORKFLOW_DRAFTING_MCP_NAME}_draft`;
export const WorkflowDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  steps: WorkflowDefinition.fields.steps,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/**
 * A step tool call T45 applies, decoded from the tool's name as OpenCode shows it (the tools of
 * `STEP_TOOLS_MCP`, called directly) and the call's input.
 */
export const StepToolCall = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("step_set_field"),
    input: Schema.Struct({
      fieldKey: TrimmedNonEmptyString,
      value: Schema.Json,
    }),
  }),
  Schema.Struct({
    tool: Schema.Literal("step_comment"),
    input: Schema.Struct({ body: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    tool: Schema.Literal("step_attach"),
    input: Schema.Struct({ path: Schema.String, fieldKey: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({ tool: Schema.Literal("step_done"), input: Schema.Struct({}) }),
  Schema.Struct({
    tool: Schema.Literal("step_give_up"),
    input: Schema.Struct({ note: TrimmedNonEmptyString }),
  }),
]);
export type StepToolCall = typeof StepToolCall.Type;

/** The step tools whose calls change the step, as OpenCode names them. */
export const STEP_TOOL_NAMES = StepToolCall.members.map((member) => member.fields.tool.literal);
