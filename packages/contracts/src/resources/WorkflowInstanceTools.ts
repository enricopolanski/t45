import * as Schema from "effect/Schema";

import { StringId, TrimmedNonEmptyString } from "../models/primitives.ts";

// The same operation ID survives a retried call and names its reply in the VM.
const requestId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);

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

export const WorkflowInstanceReply = Schema.Struct({
  text: Schema.String,
  isError: Schema.Boolean,
});

export const WorkflowInstanceResponse = Schema.Struct({
  ...WorkflowInstanceReply.fields,
  call: Schema.optionalKey(WorkflowInstanceCall),
});
