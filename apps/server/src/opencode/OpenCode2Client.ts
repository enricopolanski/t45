/**
 * The HTTP transport to a VM's OpenCode 2 server: the `@opencode/client`
 * client plus its `/api/event` stream and file reads, all authenticated with
 * the server's password, and the settings of chats' sessions.
 *
 * @module opencode/OpenCode2Client
 */
import {
  Model,
  OpenCode,
  type OpenCodeClient,
  type Permission,
  type SessionMessage,
} from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** The server sent nothing, not even a heartbeat, for `SilentStreamTimeout`. */
class OpenCode2SilentStreamError extends Schema.TaggedError<OpenCode2SilentStreamError>()(
  "OpenCode2SilentStreamError",
  {},
) {
  override get message(): string {
    return "The OpenCode server stopped sending events.";
  }
}

/** Where a VM's files live, and where its OpenCode sessions are located. */
export const WORK_DIRECTORY = "/work";

/** Where a chat's VM keeps the files members sent, relative to its folder. */
export const ATTACHMENTS_FOLDER = "attachments";

/**
 * A chat's session permission rules. OpenCode checks the agent's rules and then
 * these, and the last rule that matches decides, so this overrides the agent's:
 * the agent's sandbox is what confines it. Its origin decides whether somebody can answer questions.
 */
export const sessionRules = (policy: {
  readonly questions: boolean;
}): ReadonlyArray<Permission.Rule> => [
  { action: "*", resource: "*", effect: "allow" },
  ...(policy.questions ? [] : [{ action: "question", resource: "*", effect: "deny" } as const]),
];

/**
 * The model OpenCode should run for a `provider/model` slug, or undefined for
 * any other slug: sending none would run OpenCode's default while T45 records
 * the agent's model.
 */
export const modelRef = (model: string) =>
  Option.getOrUndefined(Option.liftThrowable(Model.Ref.parse)(model.trim()));

/** The text parts of a tool's content, joined. */
export const textOf = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

/**
 * Streams every item of a cursor-paged OpenCode 2 list. The first request
 * carries the caller's input (including `order`); later requests send only
 * the cursor, because OpenCode rejects a cursor combined with `order`.
 */
export const listSessions = (client: OpenCodeClient) => {
  const first: NonNullable<Parameters<OpenCodeClient["session"]["list"]>[0]> = { order: "asc" };
  return Stream.paginate(first, (request) =>
    client.session
      .list(request)
      .pipe(
        Effect.map(
          (page) =>
            [
              page.data,
              page.data.length === 0 || page.cursor.next === undefined
                ? Option.none()
                : Option.some({ ...request, order: undefined, cursor: page.cursor.next }),
            ] as const,
        ),
      ),
  );
};

/**
 * The sessions under `root` among `sessions`, through any nesting, each after its parent: the
 * subagents' sessions of a chat. A parent cycle can't repeat one.
 */
export const sessionsUnder = <
  S extends { readonly id: string; readonly parentID?: string | null | undefined },
>(
  root: string,
  sessions: ReadonlyArray<S>,
): ReadonlyArray<S> => {
  const children = new Map<string, Array<S>>();
  for (const session of sessions) {
    if (session.parentID === undefined || session.parentID === null) continue;
    const siblings = children.get(session.parentID) ?? [];
    siblings.push(session);
    children.set(session.parentID, siblings);
  }
  const under: Array<S> = [];
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

/**
 * An OpenCode 2 client plus its `/api/event` stream, read with a silence
 * timeout. The server runs the same OpenCode release as `@opencode/protocol`,
 * so a frame that does not decode fails the stream. `events` succeeds once the server accepted the subscription: the stream is
 * volatile, so callers subscribe before they start work whose events they need.
 */
export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  readonly events: Effect.Effect<
    Stream.Stream<
      OpenCodeEvent,
      | HttpClientError.HttpClientError
      | Sse.Retry
      | Sse.SseError
      | Schema.SchemaError
      | OpenCode2SilentStreamError
    >,
    HttpClientError.HttpClientError
  >;
  /** A file's bytes, relative to the server's folder; null when the read times out. */
  readonly readFile: (
    path: string,
  ) => Effect.Effect<Uint8Array | null, HttpClientError.HttpClientError>;
}

/**
 * How long `/api/event` may send nothing before it fails. OpenCode writes a
 * `: heartbeat` comment every 10 to 15 seconds, so this long without a single
 * byte means the server is stuck, not idle. Fakes that send no heartbeats set
 * it to infinity, so tests can move a `TestClock` past it.
 */
export class SilentStreamTimeout extends Context.Reference<Duration.Duration>(
  "t45/opencode/SilentStreamTimeout",
  { defaultValue: () => Duration.seconds(45) },
) {}

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeEvent));

/** How long a file read may take: an agent can make a file as large as its VM's disk. */
const READ_FILE_TIMEOUT = "60 seconds";

/**
 * The most one answer of a VM's OpenCode may hold. The agent can change what that server sends,
 * so T45 reads no more of any answer than this; a page of messages fits many large ones.
 */
export const RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

/** Statuses whose answers have no body. */
const BODYLESS = new Set([101, 204, 205, 304]);

/** Fails an answer whose body passes `maxBytes`, as it is read, before the rest arrives. */
const capResponses = (client: HttpClient.HttpClient, maxBytes: number) =>
  HttpClient.transformResponse(
    client,
    Effect.flatMap((response) => {
      const tooLarge = () =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request: response.request,
            response,
            description: `The answer is larger than ${maxBytes} bytes.`,
          }),
        });
      if (Number(response.headers["content-length"]) > maxBytes) return Effect.fail(tooLarge());
      if (BODYLESS.has(response.status)) return Effect.succeed(response);
      let size = 0;
      const body = response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength;
          return size > maxBytes ? Effect.fail(tooLarge()) : Effect.succeed(chunk);
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

/** Subscribes to `/api/event`, then streams every frame as an event. */
const readEvents = (httpClient: HttpClient.HttpClient, silence: Duration.Duration) =>
  httpClient.get("/api/event", { headers: { accept: "text/event-stream" } }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.map((response) =>
      response.stream.pipe(
        Stream.timeoutOrElse({
          duration: silence,
          orElse: () => Stream.fail(new OpenCode2SilentStreamError()),
        }),
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((frame) => decodeEvent(frame.data)),
      ),
    ),
  );

/** Connects to the OpenCode 2 server at `baseUrl` through the `HttpClient` in context. */
export const connect = Effect.fnUntraced(function* (input: {
  readonly baseUrl: string;
  readonly password: string | Redacted.Redacted;
}) {
  const authenticated = HttpClient.mapRequest(
    yield* HttpClient.HttpClient,
    HttpClientRequest.basicAuth("opencode", input.password),
  );
  // The event stream runs as long as the VM does, and file reads bound themselves.
  const client = yield* OpenCode.make({ baseUrl: input.baseUrl }).pipe(
    Effect.provideService(HttpClient.HttpClient, capResponses(authenticated, RESPONSE_MAX_BYTES)),
  );
  const prefixed = HttpClient.mapRequest(
    authenticated,
    HttpClientRequest.prependUrl(input.baseUrl),
  );
  const api: OpenCode2Api = {
    client,
    events: readEvents(prefixed, yield* SilentStreamTimeout),
    // The client has no call for it: OpenCode serves the file's raw bytes.
    readFile: (path) =>
      prefixed.get(`/api/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.timeoutOption(READ_FILE_TIMEOUT),
        Effect.map(Option.getOrNull),
      ),
  };
  return api;
});
