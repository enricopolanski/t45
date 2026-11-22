import * as Schema from "effect/Schema";

import { Workflow, WorkflowVersion } from "../models/Workflow.ts";

/**
 * The workflow draft tool's identity in OpenCode messages. The chat shows its result for the member to save.
 */
export const WORKFLOW_DRAFT_TOOL_NAME = "workflows_draft";

/** The supplied reporting capability is included in every execution. */
export const REPORTING_CAPABILITY_ID = "progress-reporting";

/** The capability whose tools read and write collections' records. */
export const COLLECTIONS_CAPABILITY_ID = "collections";
/** Saves the articles another run read; its tools read and save collection records too. */
export const EXTRACTION_SAVING_CAPABILITY_ID = "extraction-saving";
/** Lets an automation finish the workflow step it is running on. */
export const STEP_COMPLETION_CAPABILITY_ID = "step-completion";

export const WorkflowDraft = Schema.Struct({
  name: Workflow.fields.name,
  steps: WorkflowVersion.fields.steps,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;
