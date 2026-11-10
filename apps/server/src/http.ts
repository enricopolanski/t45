import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpStaticServer,
} from "effect/http";

const COMPRESSIBLE_TYPES = new Set([
  "application/json",
  "application/javascript",
  "image/svg+xml",
  "application/wasm",
  "application/x-ndjson",
]);

const isCompressible = (contentType: string) => {
  const type = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
  return type.startsWith("text/") || COMPRESSIBLE_TYPES.has(type);
};

const compression = HttpRouter.middleware(
  HttpMiddleware.compression({ compressible: isCompressible }),
  { global: true },
);

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const isSameOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const site = request.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return URL.canParse(origin) && new URL(origin).host === request.headers.host;
};

const sameOrigin = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (SAFE_METHODS.has(request.method) || isSameOrigin(request)) {
        return yield* httpEffect;
      }
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }),
  { global: true },
);

const clientDir = `${import.meta.dirname}/client`;

/** Serves the web client and applies compression and the same-origin guard to every route. */
export const layer = Layer.mergeAll(
  HttpStaticServer.layer({ root: clientDir, spa: true, cacheControl: "no-cache" }),
  HttpStaticServer.layer({
    root: `${clientDir}/assets`,
    prefix: "/assets",
    cacheControl: "public, max-age=31536000, immutable",
  }),
  compression,
  sameOrigin,
);
