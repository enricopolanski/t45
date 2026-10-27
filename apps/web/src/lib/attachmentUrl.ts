import {
  ATTACHMENT_ROUTE_PREFIX,
  type AttachmentUploadInput,
  AttachmentUploadResult,
} from "@t45/contracts/resources/Attachments";
import * as Schema from "effect/Schema";

interface AttachmentResource {
  readonly id: string;
  readonly name?: string;
}

/**
 * Where the page's server serves an attachment's bytes. The session cookie authorizes the
 * request, so the path is stable and can go straight into `src` or `href`.
 */
export function attachmentUrl(attachment: AttachmentResource): string {
  return `${ATTACHMENT_ROUTE_PREFIX}/${encodeURIComponent(attachment.id)}/${encodeURIComponent(
    attachment.name ?? attachment.id,
  )}`;
}

/** Where to POST an attachment's bytes; the response carries its pending id. */
export function attachmentUploadUrl(upload: Omit<AttachmentUploadInput, "sizeBytes">): string {
  const params = new URLSearchParams({
    type: upload.type,
    name: upload.name,
    mimeType: upload.mimeType,
  });
  return `${ATTACHMENT_ROUTE_PREFIX}?${params}`;
}

export const decodeUploadResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(AttachmentUploadResult),
);
