import { createContext, use } from "react";

import { formatAttachmentSize } from "~/lib/attachmentFiles";
import {
  type ComposerAttachment,
  composerFileNeedsReattach,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "~/composerDraftStore";
import {
  formatAttachmentUploadProgress,
  type AttachmentUploadState,
} from "~/lib/attachmentUploadState";
import { attachmentContextReference } from "~/lib/composerContextReferences";

import { ChipTooltip, FileChip, ImageChipButton, UnresolvedChip } from "./ContextChip";

/** The draft attachment behind a context reference chip, with its upload. */
type ComposerDraftContextRecord = {
  attachment: ComposerAttachment;
  upload: AttachmentUploadState | undefined;
};

type ComposerDraftContextRecords = ReadonlyMap<string, ComposerDraftContextRecord>;

/** The draft records behind the prompt's chips, keyed by context id, and what a chip can do. */
export const ComposerChipsContext = createContext<{
  records: ComposerDraftContextRecords;
  expandImage: (imageId: string) => void;
}>({ records: new Map(), expandImage: () => {} });

export function composerContextRecordsFromDraft(input: {
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
  uploadsByAttachmentId: Readonly<Record<string, AttachmentUploadState>>;
}): ComposerDraftContextRecords {
  return new Map(
    [...input.images, ...input.files].map((attachment) => [
      attachmentContextReference(attachment).contextId,
      { attachment, upload: input.uploadsByAttachmentId[attachment.id] },
    ]),
  );
}

function uploadStatusSuffix(upload: AttachmentUploadState | undefined): string | null {
  if (upload?.status === "uploading") return formatAttachmentUploadProgress(upload.progress);
  if (upload?.status === "failed") return "upload failed";
  return null;
}

function attachmentTooltip(
  attachment: ComposerAttachment,
  upload: AttachmentUploadState | undefined,
): string {
  const lines = [attachment.name, formatAttachmentSize(attachment.sizeBytes)];
  if (upload?.status === "failed") lines.push("", upload.reason);
  return lines.join("\n");
}

function ImageContextChip(props: {
  attachment: ComposerImageAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const { expandImage } = use(ComposerChipsContext);
  return (
    <ChipTooltip tooltip={attachmentTooltip(props.attachment, props.upload)}>
      <ImageChipButton
        name={props.attachment.name}
        previewUrl={props.attachment.previewUrl}
        size={formatAttachmentSize(props.attachment.sizeBytes)}
        suffix={uploadStatusSuffix(props.upload)}
        onClick={() => expandImage(props.attachment.id)}
      />
    </ChipTooltip>
  );
}

function FileContextChip(props: {
  attachment: ComposerFileAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const needsReattach = composerFileNeedsReattach(props.attachment);
  return (
    <FileChip
      name={props.attachment.name}
      size={formatAttachmentSize(props.attachment.sizeBytes)}
      error={props.upload?.status === "failed"}
      unresolved={needsReattach}
      suffix={needsReattach ? "attach again" : uploadStatusSuffix(props.upload)}
      tooltip={
        needsReattach
          ? `${props.attachment.name} was not saved with this draft. Attach it again to send it.`
          : attachmentTooltip(props.attachment, props.upload)
      }
    />
  );
}

/** Compact chip for one prompt reference, resolved against the draft's records. */
export function ComposerContextReferenceChip(props: { contextId: string; label: string }) {
  const entry = use(ComposerChipsContext).records.get(props.contextId);
  if (entry?.attachment.type === "image")
    return <ImageContextChip attachment={entry.attachment} upload={entry.upload} />;
  if (entry?.attachment.type === "file")
    return <FileContextChip attachment={entry.attachment} upload={entry.upload} />;
  return (
    <UnresolvedChip
      label={props.label}
      tooltip="This context is no longer available. Remove it or attach it again."
    />
  );
}
