// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import {
  WorkflowInstanceCall,
  WorkflowInstanceInputs,
  WorkflowInstanceResponse,
} from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { refuse, serve } from "./mcp-stdio.ts";

const directory = ".t45/replies";
// The sandbox clears .t45 on startup; receipts survive on the server.
NodeFS.mkdirSync(directory, { recursive: true });
const decodeCall = Schema.decodeUnknownResult(WorkflowInstanceCall);
const decodeResponse = Schema.decodeUnknownResult(Schema.fromJsonString(WorkflowInstanceResponse));
const sameCall = Schema.toEquivalence(WorkflowInstanceCall);
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
    const call = decoded.success;
    const response = await new Promise<typeof WorkflowInstanceResponse.Type>((resolve, reject) => {
      const read = async () => {
        try {
          const parsed = decodeResponse(
            await NodeFSP.readFile(`${directory}/${call.input.requestId}.json`, "utf8"),
          );
          if (Result.isFailure(parsed)) return; // A write may still be in progress.
          watcher.close();
          resolve(parsed.success);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          watcher.close();
          reject(error);
        }
      };
      const watcher = NodeFS.watch(directory, () => void read());
      watcher.on("error", reject);
      void read();
    });
    if (!sameCall(response.call, call))
      refuse("This requestId was already used for another operation; use a new ID.");
    if (response.isError) refuse(response.text);
    return response.text;
  },
});
