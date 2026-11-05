// The step tools inside a chat's VM: a stdio MCP server, `step` to OpenCode, that admins give the
// agents that work steps. It checks the shared input contract: T45 reads each call
// and its reply back from the chat, checks it as it applies it, and answers a refused one with a
// message in the chat. OpenCode starts it in the agent's working folder, which its paths are
// relative to. An attach is a snapshot of the file under .t45/attached, which T45 reads by the
// name the reply gives.
// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { StepToolCall } from "@t45/contracts/resources/AgentTools";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { refuse, serve } from "./mcp-stdio.ts";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const APPLIED =
  "T45 applies the call to the step and answers one it refuses with a message in this chat.";

const descriptions: Record<StepToolCall["tool"], string> = {
  step_set_field:
    "Fill one of the step's fields by its key in the step's JSON in your first message: text and dates (YYYY-MM-DD) as strings, numbers as numbers, yes/no as booleans, selects as one of the field's options; null clears it. A field inside a group has a dotted key. A repeatable group's value is its row ids in order: add a row by setting the group to its ids plus a new one (letters, digits, - and _), then fill that row's fields as group.rowId.field.",
  step_comment:
    "Post a comment on the step assigned to you: progress, a question for the people on it, or your result.",
  step_attach:
    "Attach a file from your working folder to the step assigned to you, by its path relative to that folder. Give fieldKey to make it the value of a file field.",
  step_done:
    "Submit this task only once every required field of the step is filled and every sub-step is complete. The step waits for all its automations to submit before approval. When you cannot finish, call give_up instead. Stop after calling it.",
  step_give_up:
    "Fail this task when you cannot finish its contribution. Fill what you can first, then explain what is missing and why. The responsible person is notified; other tasks continue. Stop after calling it.",
};

const attach = (path: string) => {
  let target: string;
  try {
    target = NodeFS.realpathSync(path);
  } catch {
    refuse(`No file at ${path}.`);
  }
  if (!target.startsWith(`${NodeFS.realpathSync(".")}/`))
    refuse("The file must be in your working folder.");
  const info = NodeFS.statSync(target);
  if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) refuse("Attach a file of at most 25 MB.");
  // A random name can't meet an earlier snapshot, even after the VM restarts.
  const file = `.t45/attached/${NodeCrypto.randomUUID()}`;
  NodeFS.mkdirSync(".t45/attached", { recursive: true });
  NodeFS.copyFileSync(target, file);
  return { name: NodePath.basename(target), file };
};

const tools = StepToolCall.members.map(({ fields }) => {
  const document = Schema.toJsonSchemaDocument(fields.input);
  return {
    name: fields.tool.literal.slice("step_".length),
    description: `${descriptions[fields.tool.literal]} ${APPLIED}`,
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
  const call = result.success;
  const attached = call.tool === "step_attach" ? attach(call.input.path) : undefined;
  return JSON.stringify({ ok: true, ...attached }, null, 2);
};

serve({ name: "step-tools", tools, call, failure: "The step tool failed." });
