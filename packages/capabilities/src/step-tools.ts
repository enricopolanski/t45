// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { AttachmentUploadResult } from "@t45/contracts/resources/Attachments";
import * as Schema from "effect/Schema";
import { apiHeaders, apiUrl, rpcTool, refuse, serve } from "./mcp-stdio.ts";

const step = { stepId: process.env.T45_STEP_ID! };
const attach = rpcTool(
  "attach",
  "workflows.attachStepFile",
  "Attach a file from your working folder to the file field fieldKey.",
  step,
);
const AttachInput = Schema.Struct({
  path: Schema.String,
  fieldKey: Schema.String,
});
const decodeAttach = Schema.decodeUnknownSync(AttachInput);
const decodeUpload = Schema.decodeUnknownSync(AttachmentUploadResult);
const document = Schema.toJsonSchemaDocument(AttachInput);

serve({
  name: "step-tools",
  tools: [
    rpcTool(
      "get_step",
      "workflows.getStep",
      "Read your step as the web shows it: its instructions, its fields with their keys, types and current values, a repeatable group's rowFields and rows, its inputs, comments and files.",
      step,
    ),
    rpcTool(
      "get_fields",
      "workflows.getStepFields",
      "Read only the requested step fields and authorized inputs. Pass inputs and/or fields as lists of {key}. For a records field, give recordFields to select collection columns and recordKeys to select specific linked records. An empty recordFields list returns only linked record keys. Records include collectionId and their keys. Groups have rows with values by field key and a list of field labels. For configured comparison fields, comparisonSources lists the available criteria (id, name, value) for each sourceRecordKey. Includes proposed and discarded values for the requested fields on this step; set includeProposalDetails to true on a reviewed field to include proposal ids, scores, whyYes, whyNo and criterion assessments without loading catalogue records.",
      step,
    ),
    rpcTool(
      "set_field",
      "workflows.setStepField",
      "Fill a step field by its key: text and dates (YYYY-MM-DD) as strings (text fields marked isMarkdown render Markdown: use short paragraphs, lists and labelled links with real newlines, not literal backslash-n sequences, and no enclosing code fence), numbers as JSON numbers, yes/no as booleans, selects as one of their options, URLs as http:// or https:// strings; null clears it. Nested fields use dotted keys. Set a repeatable group to the list of its row ids, then fill each row's fields as group.rowId.field, with the field ids in the group's rowFields. A refusal says exactly what didn't fit.",
      step,
    ),
    rpcTool(
      "propose_value",
      "workflows.proposeStepField",
      "Propose a value for a field marked isReviewed, which set_field refuses: a member approves or discards it. Give the value as set_field takes it, but one record's key at a time for a records field; whyYes and whyNo in a sentence or two each, saying why it fits and what doesn't; and score, from 0 to 100, how well it fits. For a record that applies to multiple input records, include their keys in sourceRecordKeys. When the field has comparisonSources, give comparison with the sourceRecordKey and one assessment for every listed criterionId. Include the candidate value and precise source evidence for each judgment, with sourceUrl when available. Mark decisive criteria isImportant. For unknown, conflicting or incomplete evidence, including unknown test conditions, use missing and explain which evidence is unavailable. A value already proposed, discarded or held is refused: get_step lists the proposals.",
      step,
    ),
    rpcTool(
      "set_proposal_filters",
      "workflows.setProposalFilters",
      "Save ordered single-decision discrepancy questions for a reviewed field's open proposals, replacing any previous questions for that field. Each question states one discrepancy (question and driftSummary) and lists one or more open proposal ids with a concise evidence reason. Group candidates that share the same discrepancy, allow single-item questions when one clear answer saves opening a datasheet, use roughly six questions as a guideline, and pass an empty list when no filter question applies.",
      step,
    ),
    rpcTool(
      "confirm_entry",
      "workflows.confirmRecordEntry",
      "Confirm one record's review entry, as its reviewer does once its values are right: get_step lists the step's recordReviews, each entry with its recordKey and rowId. Give groupFieldId, recordKey and rowId; previousValues, the entry's values as get_step shows them, by field key relative to the entry; and values, the same with your corrections. Refused, with why, when a value is missing or the entry changed meanwhile.",
      step,
    ),
    rpcTool(
      "comment",
      "workflows.commentOnStep",
      "Post a Markdown comment on your step: a question or your result. Use short paragraphs separated by blank lines, lists and labelled source links, with real newlines in the saved text, not literal backslash-n sequences. Do not wrap the comment in a code fence. Use progress_report for progress updates.",
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
        return attach.call({ attachmentId, fieldKey });
      },
    },
  ],
  failure: "The step tool failed.",
});
