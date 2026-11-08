// Step tools wait for T45 to apply the operation and return its saved result or refusal.
import { StepToolCall } from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { waitForResponse } from "./operation-response.ts";
import { refuse, serve } from "./mcp-stdio.ts";

const descriptions: Record<StepToolCall["tool"], string> = {
  step_set_field:
    "Fill one of the step's fields by its key in the step's JSON in your first message: text and dates (YYYY-MM-DD) as strings, numbers as numbers, yes/no as booleans, selects as one of the field's options; null clears it. A field inside a group has a dotted key. A repeatable group's value is its row ids in order: add a row by setting the group to its ids plus a new one (letters, digits, - and _), then fill that row's fields as group.rowId.field.",
  step_comment:
    "Post a comment on the step assigned to you: progress, a question for the people on it, or your result.",
  step_attach:
    "Attach a file from your working folder to the step assigned to you, by its path relative to that folder. Give fieldKey to make it the value of a file field.",
};

const tools = StepToolCall.members.map(({ fields }) => {
  const document = Schema.toJsonSchemaDocument(fields.input);
  return {
    name: fields.tool.literal.slice("step_".length),
    description: `${descriptions[fields.tool.literal]} Use a new UUID requestId for each operation, and the same ID and arguments when retrying it.`,
    inputSchema:
      document.schema.type === "object"
        ? { ...document.schema, $defs: document.definitions }
        : { type: "object", properties: {} },
  };
});

const decodeCall = Schema.decodeUnknownResult(StepToolCall);
const call = (name: string, args: Record<string, unknown>) => {
  const result = decodeCall({ tool: `step_${name}`, input: args });
  if (Result.isFailure(result)) refuse(result.failure.message);
  return waitForResponse(result.success);
};

serve({ name: "step-tools", tools, call, failure: "The step tool failed." });
