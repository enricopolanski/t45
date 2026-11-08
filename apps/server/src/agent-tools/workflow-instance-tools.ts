// @effect-diagnostics nodeBuiltinImport:off
import { WorkflowInstanceCall, WorkflowInstanceInputs } from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { waitForResponse } from "./operation-response.ts";
import { refuse, serve } from "./mcp-stdio.ts";

const decodeCall = Schema.decodeUnknownResult(WorkflowInstanceCall);
const descriptions = {
  get_workflow:
    "Read this conversation's workflow and its current blueprint, including step and field IDs.",
  list_tickets:
    "List up to 100 visible tickets in this workflow, newest first; optionally search their titles.",
  get_ticket: "Read a visible ticket in this workflow, including its steps, values and IDs.",
  create_ticket: "Start a ticket using the member's normal permissions; return the saved ticket.",
  set_field:
    "Set a field on an actionable step using the member's normal permissions; return the saved ticket.",
};
const tools = Object.entries(WorkflowInstanceInputs).map(([name, schema]) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    name,
    description: `${descriptions[name as keyof typeof descriptions]} Use a new UUID requestId for each operation, and the same ID and arguments when retrying it.`,
    inputSchema: { ...document.schema, $defs: document.definitions },
  };
});

serve({
  name: "workflow-instance-tools",
  tools,
  failure: "The workflow operation could not complete.",
  call: async (tool, input) => {
    const decoded = decodeCall({ tool, input });
    if (Result.isFailure(decoded)) refuse(decoded.failure.message);
    return waitForResponse(decoded.success);
  },
});
