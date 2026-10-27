import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { WORKFLOW_DRAFTING_MCP_NAME } from "../models/Agent.ts";
import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { Comment, FieldPathSegment, WorkflowDefinition } from "../models/Workflow.ts";
import { FieldView } from "./Workflows.ts";

/**
 * The `draft` tool of `WORKFLOW_DRAFTING_MCP` as OpenCode names it, and what that takes: a name and the steps. The chat shows the draft for the member to create.
 */
export const WORKFLOW_DRAFT_TOOL_NAME = `${WORKFLOW_DRAFTING_MCP_NAME}_draft`;
export const WorkflowDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  steps: WorkflowDefinition.fields.steps,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/** A field as an agent reads it: like a step's view, with a file's name instead of the file. */
interface BriefField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: FieldView["type"];
  readonly options: ReadonlyArray<string>;
  readonly value: Schema.Json;
  readonly fileName: string | null;
  readonly repeatable: boolean;
  readonly rows: ReadonlyArray<{
    readonly id: string | null;
    readonly fields: ReadonlyArray<BriefField>;
  }>;
}
const BriefFieldRef = Schema.suspend((): Schema.Codec<BriefField> => BriefField);
const BriefField = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.String,
  type: FieldView.fields.type,
  options: Schema.Array(Schema.String),
  value: Schema.Json,
  repeatable: Schema.Boolean,
  fileName: Schema.NullOr(Schema.String),
  rows: Schema.Array(
    Schema.Struct({
      id: Schema.NullOr(FieldPathSegment),
      fields: Schema.Array(BriefFieldRef),
    }),
  ),
});

/**
 * Everything an agent working a step receives, and nothing else of its ticket: the instructions,
 * the filled fields of earlier steps (files included), its fields, and its comments. An agent
 * working a sub-step gets the sub-step, the names of the steps it sits in, and what they carry.
 */
export const AgentBrief = Schema.Struct({
  workflowName: TrimmedNonEmptyString,
  ticketTitle: TrimmedNonEmptyString,
  ticketDescription: Schema.String,
  stepName: TrimmedNonEmptyString,
  instructions: Schema.String,
  /** The steps the worked step sits in, outermost first, for context. */
  parents: Schema.Array(Schema.Struct({ name: Schema.String, instructions: Schema.String })),
  inputs: Schema.Array(Schema.Struct({ stepName: TrimmedNonEmptyString, ...BriefField.fields })),
  fields: Schema.Array(BriefField),
  comments: Schema.Array(
    Schema.Struct(Struct.pick(Comment.fields, ["author", "body", "createdAt"])),
  ),
  attachments: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString })),
});
export type AgentBrief = typeof AgentBrief.Type;

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
