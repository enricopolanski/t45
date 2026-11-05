import { OpenCode, type Permission, type Session } from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { Vm } from "./Sandbox.ts";

/**
 * OpenCode checks the agent's rules, then these, and the last match decides: the sandbox is what
 * confines the agent.
 */
export const sessionRules = (questions: boolean): ReadonlyArray<Permission.Rule> => [
  { action: "*", resource: "*", effect: "allow" },
  ...(questions ? [] : [{ action: "question", resource: "*", effect: "deny" } as const]),
];

/** The sessions under `root`, each after its parent; the agent controls parents, so a cycle can't repeat one. */
export const sessionsUnder = (root: string, sessions: ReadonlyArray<Session.Info>) => {
  const children = new Map<string, Array<Session.Info>>();
  for (const session of sessions) {
    if (session.parentID === undefined) continue;
    const siblings = children.get(session.parentID) ?? [];
    siblings.push(session);
    children.set(session.parentID, siblings);
  }
  const under: Array<Session.Info> = [];
  const seen = new Set([root]);
  const parents = [root];
  for (let at = 0; at < parents.length; at++) {
    for (const child of children.get(parents[at] ?? "") ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      under.push(child);
      parents.push(child.id);
    }
  }
  return under;
};

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeEvent));

/** The agent controls what OpenCode answers, so the runner reads no more of any answer. */
const RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

const BODYLESS = new Set([101, 204, 205, 304]);

const capResponses = (client: HttpClient.HttpClient) =>
  HttpClient.transformResponse(
    client,
    Effect.flatMap((response) => {
      if (BODYLESS.has(response.status)) return Effect.succeed(response);
      let size = 0;
      const body = response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength;
          return size <= RESPONSE_MAX_BYTES
            ? Effect.succeed(chunk)
            : Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.DecodeError({
                    request: response.request,
                    response,
                    description: `The answer is larger than ${RESPONSE_MAX_BYTES} bytes.`,
                  }),
                }),
              );
        }),
      );
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          response.request,
          new Response(Stream.toReadableStream(body), {
            status: response.status,
            headers: { ...response.headers },
          }),
        ),
      );
    }),
  );

/** OpenCode writes a heartbeat every 10 to 15 seconds. */
const readEvents = (httpClient: HttpClient.HttpClient) =>
  httpClient.get("/api/event", { headers: { accept: "text/event-stream" } }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.map((response) =>
      response.stream.pipe(
        Stream.timeout("45 seconds"),
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((frame) => decodeEvent(frame.data)),
      ),
    ),
    Stream.unwrap,
  );

/**
 * The event stream is volatile: work whose events matter starts after its `server.connected`.
 * It ends when OpenCode goes silent.
 */
export const connect = Effect.fnUntraced(function* (server: Pick<Vm, "url" | "password">) {
  const authenticated = HttpClient.mapRequest(
    yield* HttpClient.HttpClient,
    HttpClientRequest.basicAuth("opencode", server.password),
  );
  const client = yield* OpenCode.make({ baseUrl: server.url }).pipe(
    Effect.provideService(HttpClient.HttpClient, capResponses(authenticated)),
  );
  const prefixed = HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(server.url));
  return {
    client,
    events: readEvents(prefixed),
    /** Bounded by time only: an agent can make a file as large as its disk. */
    readFile: (path: string) =>
      prefixed.get(`/api/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.timeout("60 seconds"),
      ),
  };
});
