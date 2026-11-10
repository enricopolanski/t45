import type { ChatContextId, ChatContextKind } from "@t45/contracts/models/Attachment";
import {
  collectComposerContextReferences,
  type ComposerContextReferenceOccurrence,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t45/core/composerContextReferences";

import type { ComposerAttachment, ComposerFileAttachment } from "~/composerDraftStore";

/**
 * Prompt-string operations on inline context references and attachment undo reconciliation.
 */

export type ComposerContextReference = Pick<
  ComposerContextReferenceOccurrence,
  "kind" | "contextId" | "label"
>;

/** Producer ids are UUIDs, so `<kind>_<uuid>` always fits the context-id grammar. */
export function contextIdFor(kind: ChatContextKind, producerId: string): ChatContextId {
  return `${kind}_${producerId}` as ChatContextId;
}

/** Payload ids referenced by the prompt, once each in first-occurrence order. */
export function collectInlineContextIds(prompt: string): string[] {
  return Array.from(
    new Set(collectComposerContextReferences(prompt).map((occurrence) => occurrence.contextId)),
  );
}

/**
 * Every link replaced by its label: what copied text carries, and what pasted text becomes.
 * Context never travels through the clipboard, so a pasted link would only be a dead chip.
 */
export function inlineContextReferencesToLabels(text: string): string {
  return replaceComposerContextReferences(text, (occurrence) => occurrence.label);
}

/** Prose without any context link, for "does this prompt say anything" checks. */
export function stripInlineContextReferences(prompt: string): string {
  return replaceComposerContextReferences(prompt, () => "");
}

function isBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** Replaces a selected range with chips, keeping word boundaries and the trailing caret space. */
export function inlineContextReferenceReplacement(
  prompt: string,
  selection: { start: number; end: number },
  references: ReadonlyArray<ComposerContextReference>,
): { start: number; end: number; text: string } {
  const start = Math.max(0, Math.min(prompt.length, Math.floor(selection.start)));
  const end = Math.max(start, Math.min(prompt.length, Math.floor(selection.end)));
  const needsLeadingSpace = !isBoundaryWhitespace(prompt[start - 1]);
  return {
    start,
    end: prompt[end] === " " ? end + 1 : end,
    text: `${needsLeadingSpace ? " " : ""}${references.map(formatComposerContextReference).join(" ")} `,
  };
}

/**
 * The prompt without its references to `contextId`, or without every reference, each taking one
 * neighbouring space along so words don't join.
 */
export function removeContextReferences(prompt: string, contextId?: string): string {
  let result = prompt;
  let start = -1;
  for (const occurrence of collectComposerContextReferences(prompt).toReversed()) {
    if (contextId !== undefined && occurrence.contextId !== contextId) continue;
    let end = occurrence.end;
    start = occurrence.start;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return start >= result.length ? result.trimEnd() : result;
}

/** Appends links for records the prompt does not reference yet, in the order given. */
export function ensureInlineContextReferences(
  prompt: string,
  references: ReadonlyArray<ComposerContextReference>,
): string {
  const referenced = new Set(collectInlineContextIds(prompt));
  const missing: ComposerContextReference[] = [];
  for (const reference of references) {
    if (referenced.has(reference.contextId)) continue;
    referenced.add(reference.contextId);
    missing.push(reference);
  }
  if (missing.length === 0) return prompt;
  const edit = inlineContextReferenceReplacement(
    prompt,
    { start: prompt.length, end: prompt.length },
    missing,
  );
  return `${prompt}${edit.text}`;
}

export function attachmentContextReference(
  attachment: ComposerAttachment,
): ComposerContextReference {
  return {
    kind: attachment.type,
    contextId: contextIdFor(attachment.type, attachment.id),
    label: attachment.name,
  };
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  retained: Map<string, ComposerFileAttachment>;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
} {
  const liveFileContextIds = new Set<string>(
    input.files.map((file) => attachmentContextReference(file).contextId),
  );
  const filesToRemove: string[] = [];
  for (const file of input.files) {
    const contextId = attachmentContextReference(file).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.set(contextId, file);
    filesToRemove.push(file.id);
  }
  const filesToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveFileContextIds.has(contextId)) return [];
    const file = input.retained.get(contextId);
    input.retained.delete(contextId);
    return file ? [file] : [];
  });

  return { filesToRemove, filesToRestore };
}
