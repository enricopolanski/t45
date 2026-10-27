import { ChatContextId } from "@t45/contracts/models/Chat";
import { describe, expect, it } from "vite-plus/test";

import { parseInlineTokens, type InlineToken } from "./inlineTokens";
import { formatComposerContextReference } from "@t45/core/composerContextReferences";

const fileContextId = ChatContextId.make("file_ctx-1");
const fileReference = formatComposerContextReference({
  kind: "file",
  contextId: fileContextId,
  label: "notes.txt",
});
const fileSegment: Extract<InlineToken, { type: "context-reference" }> = {
  type: "context-reference",
  kind: "file",
  contextId: fileContextId,
  label: "notes.txt",
  source: fileReference,
};

describe("parseInlineTokens", () => {
  it("keeps context references at their prompt positions", () => {
    expect(parseInlineTokens(`Inspect ${fileReference} please`)).toEqual([
      { type: "text", text: "Inspect " },
      fileSegment,
      { type: "text", text: " please" },
    ]);
  });

  it("preserves consecutive context references without dropping positions", () => {
    expect(parseInlineTokens(`${fileReference}${fileReference}tail`)).toEqual([
      fileSegment,
      fileSegment,
      { type: "text", text: "tail" },
    ]);
  });

  it("leaves a context link with an unparsable href as text", () => {
    const prompt = "see [x](t45-context:file/ctx 1) now";
    expect(parseInlineTokens(prompt)).toEqual([{ type: "text", text: prompt }]);
  });

  it("returns no segments for an empty prompt", () => {
    expect(parseInlineTokens("")).toEqual([]);
  });

  it("parses the image form of a context reference", () => {
    const imageContextId = ChatContextId.make("image_ctx-1");
    const imageReference = formatComposerContextReference({
      kind: "image",
      contextId: imageContextId,
      label: "shot.png",
    });
    const imageSegment: Extract<InlineToken, { type: "context-reference" }> = {
      type: "context-reference",
      kind: "image",
      contextId: imageContextId,
      label: "shot.png",
      source: imageReference,
    };

    expect(parseInlineTokens(`Screenshot ${imageReference} attached`)).toEqual([
      { type: "text", text: "Screenshot " },
      imageSegment,
      { type: "text", text: " attached" },
    ]);
  });

  it("leaves a context link with an unknown kind as text", () => {
    const prompt = "see [s](t45-context:snippet/file_ctx-1) now";
    expect(parseInlineTokens(prompt)).toEqual([{ type: "text", text: prompt }]);
  });
});
