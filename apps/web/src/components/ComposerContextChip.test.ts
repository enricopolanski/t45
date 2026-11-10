import { describe, expect, it } from "vite-plus/test";

import { attachmentContextReference } from "~/lib/composerContextReferences";
import { composerContextRecordsFromDraft } from "./ComposerContextChip";

describe("composerContextRecordsFromDraft", () => {
  it("resolves each wire reference to its own backing draft when an image and file share an id", () => {
    const id = "attachment-1";
    const image = {
      type: "image" as const,
      id,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    const file = {
      type: "file" as const,
      id,
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    const draftRecords = composerContextRecordsFromDraft({
      images: [image],
      files: [file],
      uploadsByAttachmentId: {},
    });
    expect(draftRecords.size).toBe(2);
    for (const attachment of [image, file]) {
      const { contextId } = attachmentContextReference(attachment);
      expect(draftRecords.get(contextId)?.attachment).toBe(attachment);
    }
  });
});
