import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

/**
 * This server's own API, as a client: a runner whose sandboxes can't reach the server relays their
 * requests, and the server sends them here. Requests take a path, such as `/api/rpc`.
 */
export class OwnApi extends Context.Service<OwnApi, HttpClient.HttpClient>()("t45/runner/OwnApi") {}

/** Where this server answers itself; a wildcard bind answers on loopback too. */
const origin = Effect.gen(function* () {
  const host = yield* ServerConfig.host;
  const port = yield* ServerConfig.port;
  if (host === "0.0.0.0" || host === "::") return `http://127.0.0.1:${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}).pipe(Effect.orDie);

/** Over loopback to the port this server listens on, read when a request goes out. */
export const layerLoopback = Layer.effect(
  OwnApi,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(
      HttpClient.mapRequestEffect((request) =>
        Effect.map(origin, (url) => HttpClientRequest.prependUrl(request, url)),
      ),
    );
  }),
);
