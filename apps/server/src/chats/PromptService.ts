import type { Form } from "@opencode/schema/form";
import type {
  AttachmentId,
  ChatAttachment,
  ChatContextId,
  ChatContextKind,
} from "@t45/contracts/models/Attachment";
import type { InputPayload } from "@t45/contracts/models/Chat";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t45/core/composerContextReferences";
import * as Schema from "effect/Schema";

/** Where a file sent to a chat is, relative to the agent's working folder. */
export const attachmentFile = (id: AttachmentId) => `attachments/${id}`;

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
    expandContextReferences(text, input.attachments),
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
    const references = attachments.map(
      (attachment) =>
        `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(attachmentFile(attachment.id))}`,
    );
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
function expandContextReferences(text: string, attachments: ReadonlyArray<ChatAttachment>) {
  const occurrences = collectComposerContextReferences(text);
  if (occurrences.length === 0) return text;
  const attachmentsById = new Map(
    attachments.map((attachment) => [attachment.contextId, attachment]),
  );
  const body = replaceComposerContextReferences(text, (occurrence) =>
    formatContextMarker(
      attachmentsById.get(occurrence.contextId)?.type ?? occurrence.kind,
      occurrence.label,
      occurrence.contextId,
    ),
  );
  const seen = new Set<ChatContextId>();
  const entries: string[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    const attachment = attachmentsById.get(occurrence.contextId);
    entries.push(
      formatEnvelopeEntry(attachment?.type ?? occurrence.kind, occurrence.contextId, attachment),
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
  attachment: ChatAttachment | undefined,
) {
  // Both attributes are schema-validated: a fixed kind and an id of `[a-z0-9_-]`.
  const open = `<${CONTEXT_ENTRY_TAG} kind="${kind}" id="${contextId}"`;
  if (!attachment) return `${open} unavailable="true"/>`;
  const body = [
    `name: ${attachment.name}`,
    `mimeType: ${attachment.mimeType}`,
    `sizeBytes: ${attachment.sizeBytes}`,
    `attachmentId: ${attachment.id}`,
  ].join("\n");
  return `${open}>\n${escapeContextText(body)}\n</${CONTEXT_ENTRY_TAG}>`;
}

/** Names where the VM keeps each attached file, after the text. */
function appendAttachmentPaths(text: string, attachments: ReadonlyArray<ChatAttachment>) {
  const references = attachments.map(
    (attachment) =>
      `[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentFile(attachment.id)}]`,
  );
  return [text, ...references].filter((part) => part !== "").join("\n\n");
}
