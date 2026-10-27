import { type ComposerAttachment, composerFileNeedsReattach } from "../composerDraftStore";

export type AttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready"; readonly attachmentId: string }
  | { readonly status: "failed"; readonly reason: string };

export function attachmentUploadBlockReason(
  attachments: ReadonlyArray<ComposerAttachment>,
  uploadsByAttachmentId: Readonly<Record<string, AttachmentUploadState>>,
): string | null {
  const count = (matches: (attachment: ComposerAttachment) => boolean) =>
    attachments.filter(matches).length;
  const reattach = count(
    (attachment) => attachment.type === "file" && composerFileNeedsReattach(attachment),
  );
  if (reattach > 0) {
    return reattach === 1
      ? "Attach the interrupted file again or remove it"
      : "Attach the interrupted files again or remove them";
  }
  const failed = count(({ id }) => uploadsByAttachmentId[id]?.status === "failed");
  if (failed > 0) {
    return failed === 1
      ? "Retry or remove the failed attachment"
      : "Retry or remove the failed attachments";
  }
  const pending = count(({ id }) => uploadsByAttachmentId[id]?.status !== "ready");
  if (pending > 0) {
    return pending === 1 ? "Attachment still uploading" : "Attachments still uploading";
  }
  return null;
}

export function formatAttachmentUploadProgress(progress: number): string {
  return `${Math.floor(progress * 100)}%`;
}
