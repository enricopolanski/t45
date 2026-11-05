import { Model, OpenCode, type OpenCodeClient, type Permission } from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import {
  AnswerInvalid,
  type Message,
  type ExecutionRequest,
  type ExecutionUpdate,
  QuestionGone,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Latch from "effect/Latch";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Capture from "./Capture.ts";
import * as SandboxManager from "./SandboxManager.ts";

const CAPTURE_BATCH = "150 millis";

const RESTART = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

/**
 * OpenCode checks the agent's rules, then these, and the last match decides: the sandbox is what
 * confines the agent.
 */
const sessionRules = (questions: boolean): ReadonlyArray<Permission.Rule> => [
  { action: "*", resource: "*", effect: "allow" },
  ...(questions ? [] : [{ action: "question", resource: "*", effect: "deny" } as const]),
];

interface Running {
  readonly request: ExecutionRequest;
  /** Null once cancelled, so a late `send` can't bring it back. */
  readonly messages: Map<string, Message | null>;
  readonly files: Map<string, Uint8Array>;
  /** Open while a message or an event gives the attempt something to look at. */
  readonly wake: Latch.Latch;
  readonly lock: Semaphore.Semaphore;
  /** The current one, once its root is in its sandbox. */
  attempt: Attempt | null;
}

interface Attempt {
  readonly client: OpenCodeClient;
  readonly sent: Set<string>;
  readonly putFiles: Effect.Effect<void>;
}

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
export const connect = Effect.fnUntraced(function* (url: string, password: Redacted.Redacted) {
  const authenticated = HttpClient.mapRequest(
    yield* HttpClient.HttpClient,
    HttpClientRequest.basicAuth("opencode", password),
  );
  const client = yield* OpenCode.make({ baseUrl: url }).pipe(
    Effect.provideService(HttpClient.HttpClient, capResponses(authenticated)),
  );
  const prefixed = HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(url));
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

/**
 * OpenCode answers before its MCP servers connect, and a turn started then finds no tools. Giving
 * up is not a loss: the chat fails instead of restarting a sandbox whose OpenCode never serves.
 */
const ready = Effect.fnUntraced(function* (
  client: OpenCodeClient,
  agent: ExecutionRequest["agent"],
) {
  yield* client.server
    .info()
    .pipe(Effect.retry(Schedule.spaced("250 millis")), Effect.timeout("1 minute"));
  const servers = Object.keys(agent.mcpServers);
  if (servers.length === 0) return;
  yield* client.mcp.list().pipe(
    Effect.filterOrFail(({ data }) =>
      servers.every((name) =>
        data.some((server) => server.name === name && server.status.status === "connected"),
      ),
    ),
    Effect.retry(Schedule.spaced("500 millis")),
    Effect.timeout("1 minute"),
  );
});

/** The event stream ended, by silence, a frame that doesn't decode, or anything else. */
class StreamEndedError extends Schema.TaggedError<StreamEndedError>()("StreamEndedError", {}) {}

/** The sandbox is out of reach; OpenCode's client wraps such a failure in a `ClientError`. */
const isLost = (error: unknown) => {
  if (Predicate.isTagged(error, "StreamEndedError")) return true;
  const failure =
    Predicate.isTagged(error, "ClientError") && "cause" in error ? error.cause : error;
  return HttpClientError.isHttpClientError(failure) && failure.reason._tag === "TransportError";
};

export const layer = RunnerRpcs.toLayer(
  Effect.gen(function* () {
    const start = yield* SandboxManager.make;
    const executions = new Map<string, Running>();

    /**
     * In a new sandbox, removed when it ends, whose disk is saved once OpenCode is done with every
     * message. Fails when the sandbox is lost.
     */
    const attempt = Effect.fnUntraced(function* (
      id: string,
      running: Running,
      emit: (event: ExecutionUpdate) => Effect.Effect<void>,
    ) {
      const { request } = running;
      const root = request.root;
      const sandbox = yield* start(id, request.agent, request.disk);
      const { client, events, readFile } = yield* connect(
        `http://127.0.0.1:${sandbox.port}`,
        sandbox.password,
      );
      yield* ready(client, request.agent);
      const capture = Capture.make({ client, readFile, root, emit });

      const written = new Set<string>();
      /** One the sandbox refuses is skipped. */
      const putFiles = Effect.forEach(
        running.files,
        ([path, content]) =>
          written.has(path)
            ? Effect.void
            : sandbox.write(path, content).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Writing a file into a sandbox failed", { id, path, error }),
                ),
                Effect.andThen(Effect.sync(() => written.add(path))),
              ),
        { discard: true },
      );
      const sent = new Set<string>();
      const deliver = running.lock.withPermit(
        Effect.gen(function* () {
          yield* putFiles;
          for (const message of running.messages.values()) {
            if (message === null || sent.has(message.id)) continue;
            yield* client.session.prompt({ ...message, sessionID: root, delivery: "queue" });
            sent.add(message.id);
          }
        }),
      );
      const done = Effect.gen(function* () {
        for (const message of running.messages.values()) {
          if (message !== null && !sent.has(message.id)) return false;
        }
        return yield* capture.idle;
      });

      const connected = yield* Latch.make();
      /** Until OpenCode is done with every message; returns the root's outcome. */
      const converse = Effect.gen(function* () {
        yield* connected.await;
        yield* putFiles;
        const model = Model.Ref.parse(request.agent.model);
        // A root the disk kept comes back as it is.
        yield* client.session.create({
          id: root,
          title: request.title,
          model,
          permissions: sessionRules(request.questions),
        });
        yield* client.session.switchModel({ sessionID: root, model });
        running.attempt = { client, sent, putFiles };
        while (true) {
          yield* deliver;
          yield* capture.marked;
          if (yield* done) {
            yield* capture.all;
            if (yield* done) {
              const info = yield* client.session.get({ sessionID: root });
              return info.outcome === "failed" ? ("failed" as const) : null;
            }
          }
          yield* running.wake.await;
          yield* Effect.sleep(CAPTURE_BATCH);
          yield* running.wake.close;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running.attempt = null;
          }),
        ),
      );

      const lost = events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "server.connected") yield* connected.open;
            else if (yield* capture.observe(event)) yield* running.wake.open;
          }),
        ),
        Effect.catch((error) => Effect.logInfo("A sandbox's event stream failed", { id, error })),
        Effect.andThen(Effect.fail(new StreamEndedError())),
      );

      // The loser is interrupted before the race returns, so the stream is gone before `save`
      // removes the VM.
      const outcome = yield* Effect.raceFirst(converse, lost);
      yield* emit({ _tag: "finished", outcome, disk: yield* sandbox.save });
    });

    /** A question goes with its sandbox, so there is none without an attempt. */
    const onAttempt = <A, E>(
      id: string,
      use: (running: Running, attempt: Attempt) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const running = executions.get(id);
        if (running === undefined || running.attempt === null) return yield* new QuestionGone();
        return yield* use(running, running.attempt);
      });

    return RunnerRpcs.of({
      execute: ({ id, request }) =>
        Stream.callback((queue) =>
          Effect.gen(function* () {
            const running: Running = {
              request,
              messages: new Map(request.messages.map((message) => [message.id, message])),
              files: new Map(Object.entries(request.files)),
              wake: yield* Latch.make(),
              lock: yield* Semaphore.make(1),
              attempt: null,
            };
            executions.set(id, running);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (executions.get(id) === running) executions.delete(id);
              }),
            );
            const emit = (event: ExecutionUpdate) => Queue.offer(queue, event).pipe(Effect.asVoid);
            yield* emit({ _tag: "heartbeat" }).pipe(
              Effect.repeat(Schedule.spaced("15 seconds")),
              Effect.forkScoped,
            );
            yield* attempt(id, running, emit).pipe(
              Effect.scoped,
              Effect.tapError((error) =>
                isLost(error)
                  ? Effect.logWarning("A sandbox was lost; its execution starts over", {
                      id,
                      error,
                    }).pipe(Effect.andThen(emit({ _tag: "restarted" })))
                  : Effect.logError("An execution failed", { id, error }),
              ),
              Effect.retry({ while: isLost, schedule: RESTART }),
              Effect.orDie,
            );
            yield* Queue.end(queue);
          }),
        ),
      send: ({ id, message, files }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined || running.messages.has(message.id)) return Effect.void;
          for (const [path, content] of Object.entries(files)) running.files.set(path, content);
          running.messages.set(message.id, message);
          return running.wake.open.pipe(Effect.asVoid);
        }),
      answer: ({ id, sessionId, formId, answer, files }) =>
        onAttempt(id, (running, attempt) =>
          Effect.gen(function* () {
            for (const [path, content] of Object.entries(files)) running.files.set(path, content);
            yield* attempt.putFiles;
            yield* attempt.client.session.form.reply({
              sessionID: sessionId,
              formID: formId,
              answer,
            });
          }).pipe(
            Effect.mapError((error) =>
              error._tag === "FormInvalidAnswerError" ? new AnswerInvalid() : new QuestionGone(),
            ),
          ),
        ),
      dismiss: ({ id, sessionId, formId }) =>
        onAttempt(id, (_, attempt) =>
          attempt.client.session.form
            .cancel({ sessionID: sessionId, formID: formId })
            .pipe(Effect.mapError(() => new QuestionGone())),
        ),
      cancel: ({ id, messageId }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined) return Effect.void;
          return running.lock.withPermit(
            Effect.gen(function* () {
              running.messages.set(messageId, null);
              const current = running.attempt;
              if (current === null || !current.sent.has(messageId)) return;
              yield* current.client.session.inbox
                .cancel({ sessionID: running.request.root, inboxID: messageId })
                .pipe(Effect.ignore);
            }),
          );
        }),
    });
  }),
);
