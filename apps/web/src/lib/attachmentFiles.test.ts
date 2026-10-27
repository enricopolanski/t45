import { describe, expect, it } from "vite-plus/test";

import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./attachmentFiles";

describe("composer attachment files", () => {
  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });
    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "Copied text" })).toBe(
      false,
    );
  });

  it("claims unsupported image pastes so the composer can report them", () => {
    const images = [
      new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      new File(["tiff"], "photo.tiff", { type: "image/tiff" }),
    ];
    for (const image of images) {
      expect(
        shouldHandleComposerAttachmentPaste({ files: [image], plainText: "Image caption" }),
      ).toBe(true);
    }
  });

  it("claims generic file-only pastes so the composer can report validation errors", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
  });

  it("routes empty and oversized generic files to composer feedback", () => {
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const oversized = new File([new Uint8Array(1024)], "large.zip", {
      type: "application/zip",
    });
    expect(shouldHandleComposerAttachmentPaste({ files: [empty], plainText: "" })).toBe(true);
    expect(shouldHandleComposerAttachmentPaste({ files: [oversized], plainText: "" })).toBe(true);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldHandleComposerAttachmentPaste({ files: [], plainText: "" })).toBe(false);
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.jpg", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "shot.PNG", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "archive.zip", type: "" })).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "no-extension", type: "" })).toBe("file");
  });

  it("infers supported image types from octet-stream files", () => {
    const jpeg = new File(["jpeg"], "photo.jpg", { type: "application/octet-stream" });
    const png = new File(["png"], "shot.PNG", { type: "application/octet-stream" });

    expect(classifyComposerAttachmentFile(jpeg)).toBe("image");
    expect(classifyComposerAttachmentFile(png)).toBe("image");
    expect(normalizeComposerImageFileMimeType(jpeg).type).toBe("image/jpeg");
    expect(normalizeComposerImageFileMimeType(png).type).toBe("image/png");
  });

  it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
    const binary = new File(["binary"], "archive.bin", { type: "application/octet-stream" });
    const unknownDocument = new File(["pdf"], "report.pdf", {
      type: "application/octet-stream",
    });
    const document = new File(["pdf"], "photo.jpg", { type: "application/pdf" });
    const explicitImage = new File(["png"], "photo.jpg", { type: "image/png" });

    expect(classifyComposerAttachmentFile(binary)).toBe("file");
    expect(classifyComposerAttachmentFile(unknownDocument)).toBe("file");
    expect(classifyComposerAttachmentFile(document)).toBe("file");
    expect(classifyComposerAttachmentFile(explicitImage)).toBe("image");
    expect(normalizeComposerImageFileMimeType(binary)).toBe(binary);
    expect(normalizeComposerImageFileMimeType(document)).toBe(document);
    expect(normalizeComposerImageFileMimeType(explicitImage)).toBe(explicitImage);
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });
    expect(
      shouldHandleComposerAttachmentPaste({ files: [image], plainText: "Image caption" }),
    ).toBe(true);
  });
});
