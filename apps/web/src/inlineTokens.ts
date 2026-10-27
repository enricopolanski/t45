import { collectComposerContextReferences } from "@t45/core/composerContextReferences";

type ContextReferenceLink = ReturnType<typeof collectComposerContextReferences>[number];

/** Inline tokens mirror the shared collector's matches; offsets stay parser-internal. */
type ContextReferenceToken = {
  type: "context-reference";
} & Omit<ContextReferenceLink, "start" | "end">;

export type InlineToken = { type: "text"; text: string } | ContextReferenceToken;

export function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const { start, end, ...link } of collectComposerContextReferences(text)) {
    if (start > cursor) tokens.push({ type: "text", text: text.slice(cursor, start) });
    tokens.push({ ...link, type: "context-reference" });
    cursor = end;
  }
  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens;
}
