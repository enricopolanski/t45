import { WorkflowDraft } from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { refuse, serve } from "./mcp-stdio.ts";

const document = Schema.toJsonSchemaDocument(WorkflowDraft);
// JSON Schema omits the distinct-ID checks; reject invalid drafts here so the agent can correct them.
const decodeDraft = Schema.decodeUnknownResult(WorkflowDraft);

const call = (args: Record<string, unknown>) => {
  const result = decodeDraft(args);
  if (Result.isFailure(result)) refuse(`${result.failure.message}\nFix the draft and try again.`);
  return `Drafted "${result.success.name}". The person can save it with Save workflow in the chat, then configure and publish a project from the saved workflow.`;
};

const tools = [
  {
    name: "draft",
    call,
    description:
      "Draft a reusable workflow for the person you are chatting with. A workflow is a repeatable process: each item passes its steps in order, and each step is completed before the next starts. A step has a name, instructions, fields with labels, and sub-steps that start with it and must all be completed before it can finish. Give each step a unique id and each field an id unique among its siblings, using at least six letters, digits, underscores or hyphens. Submit the complete draft for every revision. The draft appears in the chat with a Save workflow button. The person saves the workflow, then separately configures who works on each step and publishes a project from it.",
    inputSchema: { ...document.schema, $defs: document.definitions },
  },
];

serve({ name: "workflow-tools", tools, failure: "The draft could not be checked." });
