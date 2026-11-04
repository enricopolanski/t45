/** Formats inputs and form answers for OpenCode on the runner. */
import type { Form } from "@opencode/client/effect";
import type { ChatAttachment } from "@t45/contracts/models/Attachment";
import {
  type ChatContextId,
  type ChatContextKind,
  type ChatContextRecord,
  type InputPayload,
  MESSAGE_MAX_INPUT_CHARS,
} from "@t45/contracts/models/Chat";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t45/core/composerContextReferences";
import * as Schema from "effect/Schema";

import { attachmentPath } from "../attachments/AttachmentRepository.ts";
import { ATTACHMENTS_FOLDER, WORK_DIRECTORY } from "../opencode/OpenCode2Client.ts";

const ATTACHMENTS_DIRECTORY = `${WORK_DIRECTORY}/${ATTACHMENTS_FOLDER}`;
const CONTEXT_ENVELOPE_TAG = "t45_context";
const CONTEXT_ENTRY_TAG = "context";
const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));
/** The same text is used for input length validation and delivery to the runner. */
export function format(input: InputPayload) {
  const text =
    input.text.trim() === "" && input.attachments.length > 0
      ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
      : input.text;
  return appendAttachmentPaths(
    expandContextReferences(text, input.context?.records ?? []),
    input.attachments,
  ).trim();
}

/** Answers keep their selected values and name each field's files where the VM stores them. */
export function formatAnswers(input: {
  readonly answers: Form.Answer;
  readonly attachmentsByField: Readonly<Record<string, ReadonlyArray<ChatAttachment>>>;
}): Form.Answer {
  const answers = new Map(Object.entries(input.answers));
  for (const [key, attachments] of Object.entries(input.attachmentsByField)) {
    const references = attachments.flatMap((attachment) => {
      const path = attachmentPath(ATTACHMENTS_DIRECTORY, attachment.id);
      return path === null
        ? []
        : [
            `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(path)}`,
          ];
    });
    if (references.length === 0) continue;
    const answer = answers.get(key);
    const text = references.join("\n");
    answers.set(
      key,
      Array.isArray(answer)
        ? [...answer, text]
        : answer === undefined || answer === ""
          ? text
          : `${String(answer)}\n\n${text}`,
    );
  }
  return Object.fromEntries(answers);
}

/** Every reference becomes a marker; each referenced payload appears once in the envelope. */
function expandContextReferences(text: string, records: ReadonlyArray<ChatContextRecord>) {
  const occurrences = collectComposerContextReferences(text);
  if (occurrences.length === 0) return text;
  const recordsById = new Map<ChatContextId, ChatContextRecord | undefined>();
  for (const record of records) {
    // Even callers that bypass the wire schema must not silently select an ambiguous payload.
    recordsById.set(record.contextId, recordsById.has(record.contextId) ? undefined : record);
  }
  const body = replaceComposerContextReferences(text, (occurrence) =>
    formatContextMarker(
      recordsById.get(occurrence.contextId)?.kind ?? occurrence.kind,
      occurrence.label,
      occurrence.contextId,
    ),
  );
  const seen = new Set<ChatContextId>();
  const entries: string[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    const record = recordsById.get(occurrence.contextId);
    entries.push(
      formatEnvelopeEntry(record?.kind ?? occurrence.kind, occurrence.contextId, record),
    );
  }
  return `${body}\n\n<${CONTEXT_ENVELOPE_TAG}>\n${entries.join("\n")}\n</${CONTEXT_ENVELOPE_TAG}>`;
}

function formatContextMarker(kind: ChatContextKind, label: string, contextId: ChatContextId) {
  const kindName = kind.charAt(0).toUpperCase() + kind.slice(1);
  // Labels arrive sanitized; only `;` could still blur the label into the ref.
  const cleanLabel = label.replaceAll(";", ",");
  return `[${kindName}: ${escapeContextText(cleanLabel)}; ref=${contextId}]`;
}

/** Captured text must not close the envelope and forge a record. */
function escapeContextText(text: string) {
  return text.replace(
    new RegExp(String.raw`<(?=/?(?:${CONTEXT_ENVELOPE_TAG}|${CONTEXT_ENTRY_TAG})\b)`, "gi"),
    "&lt;",
  );
}

function formatEnvelopeEntry(
  kind: ChatContextKind,
  contextId: ChatContextId,
  record: ChatContextRecord | undefined,
) {
  // Both attributes are schema-validated: a fixed kind and an id of `[a-z0-9_-]`.
  const open = `<${CONTEXT_ENTRY_TAG} kind="${kind}" id="${contextId}"`;
  if (!record) return `${open} unavailable="true"/>`;
  const body = [
    `name: ${record.name}`,
    `mimeType: ${record.mimeType}`,
    `sizeBytes: ${record.sizeBytes}`,
    `attachmentId: ${record.attachmentId}`,
  ].join("\n");
  return `${open}>\n${escapeContextText(body)}\n</${CONTEXT_ENTRY_TAG}>`;
}

/** Only attachment references that fit the input limit are appended. */
function appendAttachmentPaths(text: string, attachments: ReadonlyArray<ChatAttachment>) {
  let result = text;
  for (const attachment of attachments) {
    const path = attachmentPath(ATTACHMENTS_DIRECTORY, attachment.id);
    if (path === null) continue;
    const reference = `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`;
    const candidate = result ? `${result}\n\n${reference}` : reference;
    if (candidate.length <= MESSAGE_MAX_INPUT_CHARS) result = candidate;
  }
  return result;
}
