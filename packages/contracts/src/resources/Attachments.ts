import * as Schema from "effect/Schema";
import { AttachmentId, NonNegativeInt, TrimmedNonEmptyString } from "../models/primitives.ts";
import {
  ATTACHMENT_IMAGE_MIME_TYPES,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_FILE_BYTES,
} from "../models/Attachment.ts";

export const ATTACHMENT_ROUTE_PREFIX = "/api/attachments";

const ImageAttachmentUploadInput = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(ATTACHMENT_IMAGE_MIME_TYPES),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(ATTACHMENT_MAX_IMAGE_BYTES),
  ),
});

const FileAttachmentUploadInput = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(ATTACHMENT_MAX_FILE_BYTES),
  ),
});

export const AttachmentUploadInput = Schema.Union([
  ImageAttachmentUploadInput,
  FileAttachmentUploadInput,
]);
export type AttachmentUploadInput = typeof AttachmentUploadInput.Type;

export const AttachmentUploadResult = Schema.Struct({
  attachmentId: AttachmentId,
});
export type AttachmentUploadResult = typeof AttachmentUploadResult.Type;
