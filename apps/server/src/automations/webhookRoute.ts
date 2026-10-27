import { WEBHOOK_ROUTE_PREFIX } from "@t45/contracts/resources/Automations";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { AutomationService } from "./AutomationService.ts";

export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const json = (status: number, body: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Handles `/api/hooks/:automationId/:token` for every accepted method. The route
 * is raw so the signature is checked over the exact body bytes; the service
 * checks the token and signature.
 */
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { automationId = "", token = "" } = yield* HttpRouter.params;
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
    return json(413, { error: "body_too_large" });
  }
  // Chunked requests carry no content-length, so the reader itself is capped.
  const body = yield* request.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES)),
    Effect.option,
  );
  // Refused before an automation is looked up, so the service never sees them.
  if (Option.isNone(body)) {
    return json(413, { error: "body_too_large_or_unreadable" });
  }
  if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
    return json(413, { error: "body_too_large" });
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const queryIndex = request.url.indexOf("?");
  const service = yield* AutomationService;
  const result = yield* service
    .deliver({
      automationId,
      token,
      method: request.method,
      path: `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(automationId)}`,
      query: queryIndex === -1 ? "" : request.url.slice(queryIndex + 1),
      headers,
      body: body.value,
      bodyText: new TextDecoder().decode(body.value),
    })
    .pipe(
      // Defects too, so the sender only ever sees the fixed error body.
      Effect.catchCause((cause) =>
        Effect.logWarning("Webhook delivery failed").pipe(
          Effect.annotateLogs({ automationId }),
          Effect.andThen(Effect.logDebug("Webhook delivery failure cause", { cause })),
          Effect.as({ _tag: "error" as const }),
        ),
      ),
    );

  switch (result._tag) {
    case "accepted":
      return json(202, { chatId: result.chatId });
    case "not_found":
      return json(404, { error: "hook_not_found" });
    case "rate_limited":
      return json(429, { error: "rate_limited" });
    case "disabled":
      return json(409, { error: "hook_disabled" });
    case "bad_signature":
      return json(401, { error: "invalid_signature" });
    case "refused":
      return json(422, { error: result.reason });
    case "error":
      return json(500, { error: "internal_error" });
  }
});

const path = `${WEBHOOK_ROUTE_PREFIX}/:automationId/:token` as const;

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", path, handler),
  HttpRouter.add("PUT", path, handler),
  HttpRouter.add("PATCH", path, handler),
  HttpRouter.add("GET", path, handler),
);
