import { isAttachmentImageMimeType } from "@t45/contracts/models/Attachment";

import { isHeicImageFile, sniffImageMimeType } from "./imageCompression";

/** Give extension-recognized images a concrete type before compression. */
export function normalizeComposerImageFileMimeType(file: File): File {
  const type = sniffImageMimeType(file);
  return type === file.type
    ? file
    : new File([file], file.name, { type, lastModified: file.lastModified });
}

export function classifyComposerAttachmentFile(file: Pick<File, "name" | "type">) {
  const type = sniffImageMimeType(file);
  if (isAttachmentImageMimeType(type) || isHeicImageFile(file)) return "image";
  return type.startsWith("image/") ? "unsupported-image" : "file";
}

/** "3.2 MB" / "48 KB" label for attachment rows. Never shows "0 KB". */
export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

/**
 * Whether a paste's files should be claimed as composer attachments instead of
 * falling through to the default text paste. Deliberately no capacity or
 * pending-plan-question gate here: `addComposerAttachments` owns those limits
 * and reports them, while a gate at this layer would swallow the paste with no
 * feedback.
 */
export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      const classification = classifyComposerAttachmentFile(file);
      return classification === "image" || classification === "unsupported-image";
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
}
