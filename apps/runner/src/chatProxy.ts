/*
 * T45's OpenCode client reaches a chat's server through the runner: everything under
 * `/chats/<chatId>/opencode/` goes on to the VM's OpenCode with the VM's own password, and the
 * answer streams back, the event stream included. T45 sends the runner's token as the password,
 * since OpenCode clients only speak Basic auth. The route counts as the chat being in use for as
 * long as the request is open.
 */
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { ChatTable } from "./ChatTable.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

/** Headers that belong to one hop, or that the runner sets itself. */
const HOP_HEADERS = new Set([
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

/** Statuses whose answers carry no body, so a streamed body would never run. */
const BODYLESS = new Set([204, 205, 304]);

const forwardable = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())),
  );

/** Whether the request carries the runner's token, as a bearer or as an OpenCode password. */
const carriesToken = (authorization: string | undefined, token: Redacted.Redacted) =>
  authorization === `Bearer ${Redacted.value(token)}` ||
  authorization === `Basic ${Base64.encode(`opencode:${Redacted.value(token)}`)}`;

const json = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const table = yield* ChatTable;
    const httpClient = yield* HttpClient.HttpClient;
    yield* router.add("*", "/chats/:chatId/opencode/*", forward({ config, table, httpClient }));
  }),
);

const forward = (services: {
  readonly config: RunnerConfig["Service"];
  readonly table: ChatTable["Service"];
  readonly httpClient: HttpClient.HttpClient;
}) =>
  Effect.gen(function* () {
    const { config, table, httpClient } = services;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!carriesToken(request.headers.authorization, config.token)) {
      return json(401, "The runner refused the caller's token.");
    }
    const { chatId } = yield* HttpRouter.params;
    if (chatId === undefined) return json(404, "No such chat.");
    const marker = "/opencode";
    const at = request.url.indexOf(marker, request.url.indexOf("/chats/"));
    const rest = request.url.slice(at + marker.length);
    const path = rest === "" || rest.startsWith("?") ? `/${rest}` : rest;

    // The stream outlives this handler, so the chat counts as in use until it ends; a request that
    // ends sooner, or is dropped, releases it at once.
    const scope = yield* Scope.make();
    const release = Scope.close(scope, Exit.void);
    return yield* Effect.gen(function* () {
      const server = yield* table.connect(chatId).pipe(Scope.provide(scope));
      if (Option.isNone(server)) {
        yield* release;
        return json(503, "The chat isn't running.");
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const body = hasBody
        ? new Uint8Array(
            yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))),
          )
        : null;
      let outgoing = HttpClientRequest.make(request.method as "GET")(
        `${server.value.url}${path}`,
      ).pipe(
        HttpClientRequest.setHeaders(forwardable(request.headers)),
        HttpClientRequest.basicAuth("opencode", server.value.password),
      );
      if (body !== null && body.byteLength > 0) {
        outgoing = HttpClientRequest.bodyUint8Array(
          outgoing,
          body,
          request.headers["content-type"] ?? "application/json",
        );
      }
      const response = yield* httpClient.execute(outgoing).pipe(Effect.option);
      if (Option.isNone(response)) {
        yield* release;
        return json(502, "The chat's OpenCode did not answer.");
      }
      const status = response.value.status;
      const headers = forwardable(response.value.headers);
      if (request.method === "HEAD" || BODYLESS.has(status)) {
        yield* release;
        return HttpServerResponse.empty({ status, headers });
      }
      return HttpServerResponse.stream(response.value.stream.pipe(Stream.ensuring(release)), {
        status,
        headers,
      });
    }).pipe(Effect.onError(() => release));
  });
