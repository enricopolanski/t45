import { ChatContextId } from "@t45/contracts/models/Chat";
import { formatComposerContextReference } from "@t45/core/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment } from "../composerDraftStore";
import {
  attachmentContextReference,
  buildMessageContext,
  collectInlineContextIds,
  ensureInlineContextReferences,
  inlineContextReferencesToLabels,
  inlineContextReferenceReplacement,
  reconcileAttachmentContextReferences,
  removeContextReferences,
  stripInlineContextReferences,
} from "./composerContextReferences";

const review = {
  kind: "file" as const,
  contextId: ChatContextId.make("rc-1"),
  label: "a.ts L4",
};
const preview = {
  kind: "image" as const,
  contextId: ChatContextId.make("pa-1"),
  label: "Checkout",
};
const reviewLink = "[a.ts L4](t45-context:file/rc-1)";
const previewLink = "![Checkout](t45-context:image/pa-1)";

describe("composerContextReferences", () => {
  it.each([
    { prompt: "before selected after", start: 7, end: 15, expected: `before ${reviewLink} after` },
    { prompt: "selected", start: 0, end: 8, expected: `${reviewLink} ` },
    { prompt: "aSELECTb", start: 1, end: 7, expected: `a ${reviewLink} b` },
    { prompt: "ab", start: 1, end: 1, expected: `a ${reviewLink} b` },
  ])(
    "replaces selected text in '$prompt' with the attachment chip",
    ({ prompt, start, end, expected }) => {
      const edit = inlineContextReferenceReplacement(prompt, { start, end }, [review]);
      expect(`${prompt.slice(0, edit.start)}${edit.text}${prompt.slice(edit.end)}`).toBe(expected);
    },
  );
  it("formats, collects and strips references of any kind", () => {
    expect(formatComposerContextReference(review)).toBe(reviewLink);
    const prompt = `x ${reviewLink} y ${previewLink} ${reviewLink}`;
    expect(collectInlineContextIds(prompt)).toEqual(["rc-1", "pa-1"]);
    expect(stripInlineContextReferences(prompt)).toBe("x  y  ");
  });

  it("removes every occurrence of an id, or of every id, with one neighbouring space each", () => {
    const prompt = `${reviewLink} mid ${previewLink} ${reviewLink} end`;
    expect(removeContextReferences(prompt, "rc-1")).toBe(`mid ${previewLink} end`);
    expect(removeContextReferences(prompt)).toBe("mid end");
    expect(removeContextReferences(`end with ${reviewLink}`, "rc-1")).toBe("end with");
    expect(removeContextReferences("plain ", "rc-1")).toBe("plain ");
  });

  it("appends links only for records the prompt does not mention", () => {
    expect(ensureInlineContextReferences(`see ${reviewLink}`, [review, preview])).toBe(
      `see ${reviewLink} ${previewLink} `,
    );
    expect(ensureInlineContextReferences("", [review])).toBe(`${reviewLink} `);
    expect(ensureInlineContextReferences(reviewLink, [review])).toBe(reviewLink);
  });

  it("appends missing links at the end, padding only where words would join", () => {
    expect(ensureInlineContextReferences("hello", [review, preview, review])).toBe(
      `hello ${reviewLink} ${previewLink} `,
    );
    expect(ensureInlineContextReferences("hello ", [preview])).toBe(`hello ${previewLink} `);
    expect(ensureInlineContextReferences("hello\n", [preview])).toBe(`hello\n${previewLink} `);
  });

  it("turns every link into its label", () => {
    const imageLink = "![shot.png](t45-context:image/image_9)";
    expect(
      inlineContextReferencesToLabels(`see ${reviewLink}, ${previewLink} and ${imageLink}`),
    ).toBe("see a.ts L4, Checkout and shot.png");
  });
});

describe("reconcileAttachmentContextReferences", () => {
  const file = {
    type: "file",
    id: "file-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    file: new File(["notes"], "notes.txt", { type: "text/plain" }),
  } satisfies ComposerFileAttachment;

  it("restores file bytes after deleting and undoing its chip", () => {
    const retained = new Map<string, ComposerFileAttachment>();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [file],
      retained,
    });
    expect(removed.filesToRemove).toEqual(["file-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([attachmentContextReference(file).contextId]),
      files: [],
      retained,
    });
    expect(restored.filesToRestore).toEqual([file]);
    expect(restored.filesToRestore[0]?.file).toBe(file.file);
    expect(retained.size).toBe(0);
    expect(
      buildMessageContext([
        { attachment: restored.filesToRestore[0]!, attachmentId: "uploaded-file" },
      ])?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "file",
        contextId: "file_file-1",
        attachmentId: "uploaded-file",
      }),
    ]);
  });
});
