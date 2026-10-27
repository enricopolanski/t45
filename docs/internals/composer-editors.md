# Composer coordinates and serialization

The draft store owns Markdown, while Tiptap owns the editing document. The serializer preserves whitespace and chip sources, and canonicalizes supported delimiters (`__` to `**`, `_` to `*`) and checkbox case (`[X]` to `[x]`).

Store cursors are not ProseMirror positions: collapsed coordinates count a chip as one character, expanded coordinates count its source text, and ProseMirror also counts block boundaries. Keep conversion in [the document model](../../apps/web/src/composerRichTextDoc.ts). Empty paragraphs need real caret positions even though they contain no text. Markers shown beside styled text are decorations, so offsets inside them clamp to the text edge.

Only replace editor content when the controlled text changes. Replacing it for a cursor move creates undo entries.

Task items split through native editor commands so marks and chips survive. Literal lists use [store edits](../../apps/web/src/composerPrompt.ts). Newlines become paragraph splits: trailing hard breaks otherwise appear to require two presses. Programmatic moves must explicitly scroll the caret into view.

Clipboard text must come from the Markdown serializer, not DOM text: chip labels omit the source and marker decorations are not content. Context chips are the exception: copy and paste both reduce them to their labels (see [context references](composer-context-references.md#clipboard)). Paste completes trailing chip delimiters and adds a leading boundary when inserting a chip directly after text.
