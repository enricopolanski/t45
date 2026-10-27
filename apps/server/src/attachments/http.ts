import { type Attachment } from "@t45/contracts/models/Attachment";
import {
  ATTACHMENT_ROUTE_PREFIX,
  AttachmentUploadInput,
  type AttachmentUploadResult,
} from "@t45/contracts/resources/Attachments";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { member } from "../auth/http.ts";
import { ChatService } from "../chats/ChatService.ts";
import { TicketRepository } from "../workflows/TicketRepository.ts";
import { canViewTicket } from "@t45/contracts/models/Workflow";
import { WorkflowRepository } from "../workflows/WorkflowRepository.ts";
import { AttachmentRepository, attachmentIsInlineImage } from "./AttachmentRepository.ts";

// Types a browser may render as a document if a proxy strips the disposition
// header. Downloads of these fall back to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
export function downloadContentDisposition(fileName: string): string {
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

/** Inline images render as themselves; everything else downloads inert. */
export function attachmentResponseHeaders(
  attachment: Pick<Attachment, "id" | "name" | "mimeType">,
): Record<string, string> {
  return {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(attachmentIsInlineImage(attachment.id)
      ? {}
      : {
          "Content-Disposition": downloadContentDisposition(attachment.name),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type": isSafeDownloadMimeType(attachment.mimeType)
            ? attachment.mimeType
            : "application/octet-stream",
        }),
  };
}

export const layerAttachmentRoute = HttpRouter.add(
  "GET",
  `${ATTACHMENT_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const currentUser = yield* member;
    if (HttpServerResponse.isHttpServerResponse(currentUser)) return currentUser;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ATTACHMENT_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    const attachmentId = separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
    const notFound = HttpServerResponse.text("Not Found", { status: 404 });
    const files = yield* AttachmentRepository;
    const path = files.path(attachmentId);
    const attachment = path === null ? null : yield* files.get(attachmentId);
    if (path === null || attachment === null) return notFound;

    const chats = yield* ChatService;
    const tickets = yield* TicketRepository;
    const workflows = yield* WorkflowRepository;
    const readable = Effect.gen(function* () {
      const holders = yield* files.chatsHolding(attachment.id);
      if (attachment.stepId === null && holders.length === 0) {
        return attachment.uploader === currentUser.userId;
      }
      for (const chatId of holders) {
        if ((yield* chats.access(currentUser, chatId)) !== null) return true;
      }
      if (attachment.stepId === null) return false;
      const ticket = yield* tickets.getByStepId(attachment.stepId);
      const workflow = ticket === null ? null : yield* workflows.get(ticket.workflowId);
      return (
        ticket !== null &&
        workflow !== null &&
        canViewTicket(
          { id: currentUser.userId, isOrgAdmin: currentUser.role === "admin" },
          workflow,
          ticket,
        )
      );
    });
    if (!(yield* readable)) return notFound;

    return yield* HttpServerResponse.file(path, {
      headers: attachmentResponseHeaders(attachment),
    }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound)),
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.logError("Failed to serve attachment.", { attachmentId, cause }).pipe(
            Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
          ),
      }),
    );
  }),
);

const decodeAttachmentUploadInput = Schema.decodeUnknownOption(AttachmentUploadInput);

const refuse = (error: { readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status: 400 }));

/**
 * `POST <prefix>?type=file&name=<name>&mimeType=<mime>` with the bytes as the
 * body; `Content-Length` is the size. Answers with the new pending attachment id.
 */
export const layerAttachmentUploadRoute = HttpRouter.add(
  "POST",
  ATTACHMENT_ROUTE_PREFIX,
  Effect.gen(function* () {
    const currentUser = yield* member;
    if (HttpServerResponse.isHttpServerResponse(currentUser)) return currentUser;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const contentLengthHeader = request.headers["content-length"];
    const sizeBytes = Number(contentLengthHeader);
    if (contentLengthHeader === undefined || !Number.isInteger(sizeBytes)) {
      return HttpServerResponse.text("Content-Length is required.", { status: 411 });
    }
    const params = url.value.searchParams;
    const upload = decodeAttachmentUploadInput({
      type: params.get("type"),
      name: params.get("name"),
      mimeType: params.get("mimeType"),
      sizeBytes,
    });
    if (Option.isNone(upload)) {
      return HttpServerResponse.text("Unsupported attachment.", { status: 400 });
    }

    const files = yield* AttachmentRepository;
    return yield* files.upload(upload.value, currentUser.userId, request.stream).pipe(
      Effect.map((attachment) =>
        HttpServerResponse.jsonUnsafe(
          { attachmentId: attachment.id } satisfies AttachmentUploadResult,
          { status: 201 },
        ),
      ),
      Effect.catchTags({ AttachmentSizeError: refuse, AttachmentNameError: refuse }),
      Effect.orElseSucceed(() =>
        HttpServerResponse.text("The upload was cut short.", { status: 400 }),
      ),
    );
  }),
);
