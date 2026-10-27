import * as Schema from "effect/Schema";

import { StringId, AttachmentId, NonNegativeInt, TrimmedNonEmptyString } from "./primitives.ts";

export const MESSAGE_MAX_ATTACHMENTS = 100;
export const ATTACHMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MESSAGE_MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
export const ATTACHMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const ATTACHMENT_IMAGE_MIME_TYPE_SET = new Set<string>(ATTACHMENT_IMAGE_MIME_TYPES);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isAttachmentImageMimeType(mimeType: string): boolean {
  return ATTACHMENT_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}

export { AttachmentId } from "./primitives.ts";

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: AttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(ATTACHMENT_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const PastedTextAttachmentSource = Schema.TaggedStruct("pasted-text", {});
export type PastedTextAttachmentSource = typeof PastedTextAttachmentSource.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: AttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(ATTACHMENT_MAX_FILE_BYTES),
  ),
  /** Clipboard text folded by a client. Providers keep these path-only so the
      agent can inspect the file selectively instead of eagerly spending the
      same context the fold is intended to preserve. */
  source: Schema.optional(PastedTextAttachmentSource),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;

export function limitRefusal(
  attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes">>,
): "too_many_files" | "images_too_large" | null {
  if (attachments.length > MESSAGE_MAX_ATTACHMENTS) return "too_many_files";
  const imageBytes = attachments.reduce(
    (total, attachment) =>
      total +
      (attachment.type === "image" || isAttachmentImageMimeType(attachment.mimeType)
        ? attachment.sizeBytes
        : 0),
    0,
  );
  return imageBytes > MESSAGE_MAX_TOTAL_IMAGE_BYTES ? "images_too_large" : null;
}

export class Attachment extends Schema.Opaque<Attachment>()(
  Schema.Struct({
    id: AttachmentId,
    name: TrimmedNonEmptyString,
    mimeType: TrimmedNonEmptyString,
    sizeBytes: NonNegativeInt,
    uploader: TrimmedNonEmptyString,
    /** The step it was uploaded to; null for a chat's attachment. */
    stepId: Schema.NullOr(StringId),
    fieldKey: Schema.NullOr(TrimmedNonEmptyString),
    createdAt: Schema.DateTimeUtcFromString,
  }),
) {}
