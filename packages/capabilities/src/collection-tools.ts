// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { AttachmentUploadResult } from "@t45/contracts/resources/Attachments";
import * as Schema from "effect/Schema";
import { apiHeaders, apiUrl, refuse, rpcTool, serve } from "./mcp-stdio.ts";

const UploadInput = Schema.Struct({ path: Schema.String });
const decodeUpload = Schema.decodeUnknownSync(UploadInput);
const decodeUploadResult = Schema.decodeUnknownSync(AttachmentUploadResult);
const document = Schema.toJsonSchemaDocument(UploadInput);

serve({
  name: "collection-tools",
  tools: [
    rpcTool(
      "list",
      "collections.list",
      "List the collections you can use, each with its id, its fields with their ids and types, and primaryKeyFieldId, the field whose value identifies a record.",
    ),
    rpcTool(
      "get_record",
      "collections.getRecord",
      "Look up one record by its primary key value. Answers null when the collection holds none with that key. A record has its values by field key, and updatedAt, when it was last saved.",
    ),
    rpcTool(
      "search",
      "collections.searchRecords",
      "Find records: text matches any of their text values, ignoring case; filters match top-level fields' values exactly, all of them. Records come in key order, up to limit (25 when left out); hasMore says whether more follow from offset + limit.",
    ),
    rpcTool(
      "save_record",
      "collections.saveRecord",
      "Save a record: values by field key, the primary key included, as on a step: text and dates (YYYY-MM-DD) as strings, numbers as JSON numbers, yes/no as booleans, selects as one of their options, URLs as objects with url (an http:// or https:// address) and label (the link text). A repeatable group holds its row ids, and each row's field is group.rowId.field. A file field holds the id upload_file returned. The values replace the record with that key whole, or add it when there is none, so give every value the record keeps. Answers the saved record; a refusal says exactly what didn't fit.",
    ),
    {
      name: "upload_file",
      description:
        "Upload a file from your working folder for a record's file field. Answers its id: put it in the field's value when you save the record.",
      inputSchema: { ...document.schema, $defs: document.definitions },
      call: async (input: Record<string, unknown>) => {
        const { path } = decodeUpload(input);
        const file = await NodeFSP.realpath(NodePath.resolve(path));
        const root = await NodeFSP.realpath(process.cwd());
        if (!file.startsWith(`${root}${NodePath.sep}`))
          refuse("The file must be in your working folder.");
        const stat = await NodeFSP.stat(file);
        if (!stat.isFile() || stat.size === 0 || stat.size > ATTACHMENT_MAX_FILE_BYTES)
          refuse(`Upload a file of at most ${ATTACHMENT_MAX_FILE_BYTES / 1024 / 1024} MB.`);
        const params = new URLSearchParams({
          type: "file",
          name: NodePath.basename(file),
          mimeType: "application/octet-stream",
        });
        const response = await fetch(apiUrl(`/api/attachments?${params}`), {
          method: "POST",
          headers: apiHeaders,
          body: await NodeFSP.readFile(file),
        });
        if (!response.ok) refuse(await response.text());
        return decodeUploadResult(await response.json()).attachmentId;
      },
    },
  ],
  failure: "The collection tool failed.",
});
