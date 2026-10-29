#!/usr/bin/env node
// T45 answers running native tool calls through the runner's existing file channel.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  WorkflowInstanceCall,
  WorkflowInstanceInputs,
} from "@t45/contracts/resources/WorkflowInstanceTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { refuse, serve } from "./mcp-stdio.mjs";

const descriptions = {
  get_workflow:
    "Read the current workflow instance and its complete blueprint, including nested steps and fields.",
  list_tickets:
    "List up to 100 visible tickets in this workflow, with their actual step IDs. Optionally search by title using query. total reports all matching tickets.",
  get_ticket:
    "Read one visible ticket in this workflow, including step IDs, field values and status. Match stepDefinitionId to get_workflow to find field definitions.",
  create_ticket:
    "Create a ticket in this workflow with the given title and optional description. Returns the saved ticket with its new step IDs.",
  set_field:
    "Update a field on a ticket step in this workflow using its actual step ID and field key. Values must match the field type. null clears a field. A repeatable group contains random row IDs; nested keys are groupId.rowId.fieldId. Returns the saved ticket. This does not complete or approve the step.",
};
const tools = Object.entries(WorkflowInstanceInputs).map(([name, schema]) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    name,
    description: `${descriptions[name]} Give a fresh UUID requestId for a new operation; reuse it only to retry exactly the same operation. The result confirms the actual saved state or explains a refusal.`,
    inputSchema: { ...document.schema, $defs: document.definitions },
  };
});
const decode = Schema.decodeUnknownResult(WorkflowInstanceCall);

const call = async (tool, input) => {
  const parsed = decode({ tool, input });
  if (Result.isFailure(parsed)) refuse(parsed.failure.message);
  const request = parsed.success;
  const directory = NodePath.join(process.env.T45_WORK_DIR ?? "/work", "attachments");
  NodeFS.mkdirSync(directory, { recursive: true });
  const filename = `${request.input.requestId}.json`;
  const reply = await new Promise((resolve, reject) => {
    const watcher = NodeFS.watch(directory, (_event, changed) => {
      if (changed === filename) read();
    });
    const timeout = setTimeout(() => {
      watcher.close();
      reject(
        new Error("T45 did not answer the workflow operation. Retry with the same requestId."),
      );
    }, 120_000);
    const read = () => {
      let response;
      try {
        response = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, filename), "utf8"));
      } catch {
        return;
      }
      watcher.close();
      clearTimeout(timeout);
      if (JSON.stringify(response.call) !== JSON.stringify(request)) {
        reject(new Error("That requestId belongs to another operation. Use a new UUID."));
      } else resolve(response);
    };
    read();
  });
  if (reply.isError) refuse(reply.text);
  return reply.text;
};

serve({
  name: "workflow-instance-tools",
  tools,
  call,
  failure: "The workflow operation could not be confirmed. Retry it with the same requestId.",
});
