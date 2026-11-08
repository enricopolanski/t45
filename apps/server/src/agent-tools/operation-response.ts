// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { WorkflowToolResponse } from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { refuse } from "./mcp-stdio.ts";

const directory = ".t45/replies";
NodeFS.mkdirSync(directory, { recursive: true });
const decodeResponse = Schema.decodeUnknownResult(Schema.fromJsonString(WorkflowToolResponse));
const sameCall = Schema.toEquivalence(WorkflowToolResponse.fields.call);

/** Waits for the server's committed operation result. */
export const waitForResponse = async (call: (typeof WorkflowToolResponse.Type)["call"]) => {
  const response = await new Promise<typeof WorkflowToolResponse.Type>((resolve, reject) => {
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
};
