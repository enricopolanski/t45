import {
  CHAT_CONTEXT_LABEL_MAX_CHARS,
  ChatContextId,
  ChatContextKind,
} from "@t45/contracts/models/Chat";
import * as Schema from "effect/Schema";

/**
 * Canonical inline reference: `[label](t45-context:<kind>/<contextId>)`, or the image
 * form `![label](...)`. The link carries position and identity only; the payload lives in the
 * message's context records. Labels are display text and never identity.
 */

const COMPOSER_CONTEXT_HREF_PREFIX = "t45-context:";
const CONTEXT_LINK = /!?\[([^\]\n]*)\]\((t45-context:[^\s)]+)\)/g;
const isComposerContextKind = Schema.is(ChatContextKind);
const isComposerContextId = Schema.is(ChatContextId);

function formatComposerContextHref(kind: ChatContextKind, contextId: ChatContextId) {
  return `${COMPOSER_CONTEXT_HREF_PREFIX}${kind}/${contextId}`;
}

export function parseComposerContextHref(
  href: string,
): { kind: ChatContextKind; contextId: ChatContextId } | null {
  if (!href.startsWith(COMPOSER_CONTEXT_HREF_PREFIX)) return null;
  const rest = href.slice(COMPOSER_CONTEXT_HREF_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const [kind, contextId] = parts as [string, string];
  if (!isComposerContextKind(kind) || !isComposerContextId(contextId)) return null;
  return { kind, contextId };
}

/** Labels must survive a Markdown link: no brackets or line breaks, bounded, never empty. */
export function sanitizeComposerContextLabel(label: string, kind: ChatContextKind): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_CONTEXT_LABEL_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : kind;
}

export function formatComposerContextReference(reference: {
  kind: ChatContextKind;
  contextId: ChatContextId;
  label: string;
}): string {
  const label = sanitizeComposerContextLabel(reference.label, reference.kind);
  const href = formatComposerContextHref(reference.kind, reference.contextId);
  return `${reference.kind === "image" ? "!" : ""}[${label}](${href})`;
}

export interface ComposerContextReferenceOccurrence {
  kind: ChatContextKind;
  contextId: ChatContextId;
  label: string;
  source: string;
  start: number;
  end: number;
}

export function collectComposerContextReferences(
  text: string,
): ComposerContextReferenceOccurrence[] {
  const occurrences: ComposerContextReferenceOccurrence[] = [];
  // No link can match without the protocol prefix; skip the scan entirely on
  // plain prose so long messages never pay for a regex walk per `[`.
  if (!text.includes("](t45-context:")) return occurrences;
  for (const match of text.matchAll(CONTEXT_LINK)) {
    const parsed = parseComposerContextHref(match[2]!);
    if (!parsed) continue;
    occurrences.push({
      ...parsed,
      label: sanitizeComposerContextLabel(match[1]!, parsed.kind),
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return occurrences;
}

export function replaceComposerContextReferences(
  text: string,
  replace: (occurrence: ComposerContextReferenceOccurrence) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const occurrence of collectComposerContextReferences(text)) {
    result += text.slice(cursor, occurrence.start) + replace(occurrence);
    cursor = occurrence.end;
  }
  return result + text.slice(cursor);
}
