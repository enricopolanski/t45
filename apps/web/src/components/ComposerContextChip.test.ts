import { describe, expect, it } from "vite-plus/test";

import { buildMessageContext } from "~/lib/composerContextReferences";
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
    const message = buildMessageContext([
      { attachment: image, attachmentId: "uploaded-image" },
      { attachment: file, attachmentId: "uploaded-file" },
    ])!;
    expect(draftRecords.size).toBe(2);
    for (const record of message.records) {
      expect(draftRecords.get(record.contextId)?.attachment.type).toBe(record.kind);
    }
  });
});
