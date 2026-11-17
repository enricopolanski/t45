// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import type { Collection } from "@t45/contracts/models/Collection";
import { FieldValues, fileKeys } from "@t45/contracts/models/Field";
import { AttachmentUploadResult } from "@t45/contracts/resources/Attachments";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { apiHeaders, apiUrl, callOperation, refuse, rpcTool, serve } from "./mcp-stdio.ts";

const UploadInput = Schema.Struct({ path: Schema.String });
const decodeUpload = Schema.decodeUnknownSync(UploadInput);
const decodeUploadResult = Schema.decodeUnknownSync(AttachmentUploadResult);
const document = Schema.toJsonSchemaDocument(UploadInput);

const ImportInput = Schema.Struct({
  collectionId: Schema.String,
  path: Schema.String.annotate({
    description:
      "A JSON Lines file in your working folder: one record per line, its values by field key as save_record takes them. A file field may hold the path of a file in your working folder instead of an id: it is uploaded first.",
  }),
});
const decodeImport = Schema.decodeUnknownSync(ImportInput);
const decodeLine = Schema.decodeUnknownResult(Schema.fromJsonString(FieldValues));
const importDocument = Schema.toJsonSchemaDocument(ImportInput);
/** How many refused lines an import names; the rest are only counted. */
const NAMED_REFUSALS = 10;

const resolveInWorkingFolder = async (path: string) => {
  const file = await NodeFSP.realpath(NodePath.resolve(path));
  const root = await NodeFSP.realpath(process.cwd());
  if (!file.startsWith(`${root}${NodePath.sep}`))
    refuse("The file must be in your working folder.");
  return file;
};

/** Uploads a file of the working folder as an attachment, answering its id. */
const uploadFile = async (path: string) => {
  const file = await resolveInWorkingFolder(path);
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
};

/** Whether `path` names a file of the working folder rather than an uploaded file's id. */
const isWorkingFile = (path: string) =>
  NodeFSP.stat(NodePath.resolve(path)).then(
    (stat) => stat.isFile(),
    () => false,
  );

serve({
  name: "collection-tools",
  tools: [
    rpcTool(
      "create",
      "collections.create",
      "Create a collection for the person you chat with, who must be an admin: its title, its fields (each with an id unique among its siblings, a label and a type), primaryKeyFieldId, the top-level text field whose value identifies a record, and memberUserIds, the people besides admins who work with its records (empty for admins only). Answers the collection with its id.",
    ),
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
      "Find records: each word of text appears, ignoring case, in one of fields, or of the fields the collection's layout searches when left out; filters match top-level fields' values exactly, or a number or date field within a {min, max} range, all of them. Records come in key order, up to limit (25 when left out); hasMore says whether more follow from offset + limit; matchCount counts the matching records and totalCount all of them.",
    ),
    rpcTool(
      "field_values",
      "collections.listFieldValues",
      "List the distinct values the records hold in one top-level field, such as the categories already used, so a new record reuses the same words.",
    ),
    rpcTool(
      "save_record",
      "collections.saveRecord",
      "Save a record: values by field key, the primary key included, as on a step: text and dates (YYYY-MM-DD) as strings (text fields marked isMarkdown render Markdown: use short paragraphs, lists and labelled links with real newlines, not literal backslash-n sequences, and no enclosing code fence), numbers as JSON numbers, yes/no as booleans, selects as one of their options, URLs as http:// or https:// strings. A repeatable group holds its row ids, and each row's field is group.rowId.field. A file field holds the id upload_file returned. The values replace the record with that key whole, or add it when there is none, so give every value the record keeps. Answers the saved record; a refusal says exactly what didn't fit.",
    ),
    {
      name: "upload_file",
      description:
        "Upload a file from your working folder for a record's file field. Answers its id: put it in the field's value when you save the record.",
      inputSchema: { ...document.schema, $defs: document.definitions },
      call: async (input: Record<string, unknown>) => uploadFile(decodeUpload(input).path),
    },
    {
      name: "import_records",
      description:
        "Save many records at once from a JSON Lines file, each line as save_record would save it. Lines are saved one by one: a refused line is skipped and the others are still saved. Answers how many were saved and why the first refused lines didn't fit, by line number.",
      inputSchema: { ...importDocument.schema, $defs: importDocument.definitions },
      call: async (input: Record<string, unknown>) => {
        const { collectionId, path } = decodeImport(input);
        const collection = await callOperation("collections.get", { collectionId });
        if (Result.isFailure(collection)) refuse(collection.failure);
        // The operation answers the collection already decoded.
        const { fields } = collection.success as Collection;
        const lines = (await NodeFSP.readFile(await resolveInWorkingFolder(path), "utf8"))
          .split("\n")
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => line.trim() !== "");
        let saved = 0;
        const refusals: Array<string> = [];
        for (const { line, number } of lines) {
          const values = decodeLine(line);
          if (Result.isFailure(values)) {
            refusals.push(`Line ${number}: ${values.failure.message}`);
            continue;
          }
          const record = { ...values.success };
          try {
            for (const key of fileKeys(fields, record)) {
              const value = record[key];
              if (typeof value === "string" && (await isWorkingFile(value)))
                record[key] = await uploadFile(value);
            }
          } catch (error) {
            refusals.push(`Line ${number}: ${error instanceof Error ? error.message : error}`);
            continue;
          }
          const result = await callOperation("collections.saveRecord", {
            collectionId,
            values: record,
          });
          if (Result.isSuccess(result)) saved += 1;
          else refusals.push(`Line ${number}: ${result.failure}`);
        }
        return [
          `Saved ${saved} of ${lines.length} records.`,
          ...refusals.slice(0, NAMED_REFUSALS),
          ...(refusals.length > NAMED_REFUSALS
            ? [`${refusals.length - NAMED_REFUSALS} more lines were refused.`]
            : []),
        ].join("\n");
      },
    },
  ],
  failure: "The collection tool failed.",
});
