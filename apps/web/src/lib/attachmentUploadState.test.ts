import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import { attachmentUploadBlockReason } from "./attachmentUploadState";

const image = (id: string): ComposerImageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 1,
  previewUrl: `blob:${id}`,
  file: new File(["x"], `${id}.png`),
});
const interrupted: ComposerFileAttachment = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
  file: null,
};

describe("attachmentUploadBlockReason", () => {
  it("blocks images that are missing or uploading", () => {
    expect(
      attachmentUploadBlockReason([image("image-1"), image("image-2")], {
        "image-1": { status: "uploading", progress: 0.5 },
      }),
    ).toBe("Attachments still uploading");
  });

  it("asks for an interrupted file before anything else", () => {
    expect(
      attachmentUploadBlockReason([image("image-1"), interrupted], {
        "image-1": { status: "failed", reason: "Scratch" },
      }),
    ).toBe("Attach the interrupted file again or remove it");
  });
});
