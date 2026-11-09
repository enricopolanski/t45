import * as Schema from "effect/Schema";

import { WORKFLOW_DRAFTING_MCP_NAME } from "../models/Agent.ts";
import { WorkflowDefinition } from "../models/Workflow.ts";

/**
 * The `draft` tool of `WORKFLOW_DRAFTING_MCP` as OpenCode names it, and what that takes: a name and the steps. The chat shows the draft for the member to create.
 */
export const WORKFLOW_DRAFT_TOOL_NAME = `${WORKFLOW_DRAFTING_MCP_NAME}_draft`;

export const WorkflowDraft = Schema.Struct({
  name: WorkflowDefinition.fields.name,
  steps: WorkflowDefinition.fields.steps,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;
