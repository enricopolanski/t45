// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { AttachmentUploadResult } from "@t45/contracts/resources/Attachments";
import * as Schema from "effect/Schema";
import { apiHeaders, apiUrl, workflowTool, refuse, serve } from "./mcp-stdio.ts";

const step = { stepId: process.env.T45_STEP_ID! };
const attach = workflowTool(
  "attach",
  "workflows.attachStepFile",
  "Attach a file from your working folder. Give fieldKey to fill a file field.",
  step,
);
const AttachInput = Schema.Struct({
  path: Schema.String,
  fieldKey: Schema.optionalKey(Schema.String),
});
const decodeAttach = Schema.decodeUnknownSync(AttachInput);
const decodeUpload = Schema.decodeUnknownSync(AttachmentUploadResult);
const document = Schema.toJsonSchemaDocument(AttachInput);

serve({
  name: "step-tools",
  tools: [
    workflowTool(
      "get_step",
      "workflows.getStep",
      "Read your step as the web shows it: its instructions, its fields with their keys, types and current values, a repeatable group's rowFields and rows, its inputs, comments and files.",
      step,
    ),
    workflowTool(
      "set_field",
      "workflows.setStepField",
      "Fill a step field by its key: text and dates (YYYY-MM-DD) as strings, numbers as JSON numbers, yes/no as booleans, selects as one of their options; null clears it. Nested fields use dotted keys. Set a repeatable group to the list of its row ids, then fill each row's fields as group.rowId.field, with the field ids in the group's rowFields. A refusal says exactly what didn't fit.",
      step,
    ),
    workflowTool(
      "comment",
      "workflows.commentOnStep",
      "Post a comment on your step: progress, a question, or your result.",
      step,
    ),
    {
      ...attach,
      inputSchema: { ...document.schema, $defs: document.definitions },
      call: async (input) => {
        const { path, fieldKey } = decodeAttach(input);
        const file = await NodeFSP.realpath(NodePath.resolve(path));
        const root = await NodeFSP.realpath(process.cwd());
        if (!file.startsWith(`${root}${NodePath.sep}`))
          refuse("The file must be in your working folder.");
        const stat = await NodeFSP.stat(file);
        if (!stat.isFile() || stat.size > ATTACHMENT_MAX_FILE_BYTES)
          refuse("Attach a file of at most 25 MB.");
        const bytes = await NodeFSP.readFile(file);
        const params = new URLSearchParams({
          type: "file",
          name: NodePath.basename(file),
          mimeType: "application/octet-stream",
        });
        const response = await fetch(apiUrl(`/api/attachments?${params}`), {
          method: "POST",
          headers: apiHeaders,
          body: bytes,
        });
        if (!response.ok) refuse(await response.text());
        const { attachmentId } = decodeUpload(await response.json());
        return attach.call({ attachmentId, ...(fieldKey === undefined ? {} : { fieldKey }) });
      },
    },
  ],
  failure: "The step tool failed.",
});
