import {
  type Form,
  Model,
  OpenCode,
  type OpenCodeClient,
  type Permission,
  Session,
  SessionMessage,
} from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import {
  AnswerInvalid,
  type Message,
  type ExecutionRequest,
  type ExecutionUpdate,
  isSettled,
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
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SandboxManager from "./SandboxManager.ts";

const RESTART = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

const GENERATED_FILES = ".t45/attached";

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

/** Sessions to read again, with the messages events named. */
interface Marks {
  tree: boolean;
  forms: boolean;
  readonly sessions: Map<string, Set<string>>;
}

const noMarks = (): Marks => ({ tree: false, forms: false, sessions: new Map() });

const IGNORED = new Set([
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.compaction.delta",
  "session.step.streamed",
  "session.viewed",
  "session.metadata.updated",
  "session.permissions",
  "session.usage.updated",
  "session.moved",
]);

/** Whether a pass has to look again: a shell event marks nothing, but `done` asks about shells. */
const mark = (marks: Marks, event: OpenCodeEvent): boolean => {
  const type = event.type;
  if (type.startsWith("form.")) {
    marks.forms = true;
    return true;
  }
  if (type.startsWith("shell.")) return true;
  if (!type.startsWith("session.") || IGNORED.has(type)) return false;
  if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return false;
  if (type === "session.created" || type === "session.deleted" || type === "session.renamed") {
    marks.tree = true;
    return true;
  }
  const touched = marks.sessions.get(event.data.sessionID) ?? new Set<string>();
  const id =
    ("assistantMessageID" in event.data ? event.data.assistantMessageID : undefined) ??
    ("inboxID" in event.data ? event.data.inboxID : undefined);
  if (typeof id === "string") touched.add(id);
  marks.sessions.set(event.data.sessionID, touched);
  return true;
};

/** The sessions under `root`, each after its parent; the agent controls parents, so a cycle can't repeat one. */
const sessionsUnder = (root: string, sessions: ReadonlyArray<Session.Info>) => {
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

      // What events marked since the last pass, and what the passes read so far: each session's
      // paging cursor, and whether each message was settled.
      let marks: Marks = { ...noMarks(), tree: true, forms: true };
      const known = new Set<string>([root]);
      const cursors = new Map<string, string>();
      const seen = new Map<string, Map<string, boolean>>();
      // Per subagent session, the background launches (by tool call) and the reports that reached
      // its parent (by message); a session the agent continues launches again.
      const launches = new Map<string, Set<string>>();
      const reports = new Map<string, Set<string>>();
      const add = (map: Map<string, Set<string>>, child: string, id: string) =>
        map.set(child, (map.get(child) ?? new Set()).add(id));
      const generated = new Set<string>();

      const readTree = Effect.gen(function* () {
        // Without a cap on `limit`, one answer holds every session.
        const { data: all } = yield* client.session.list({
          order: "asc",
          limit: Number.MAX_SAFE_INTEGER,
        });
        const sessions = [...all.filter((info) => info.id === root), ...sessionsUnder(root, all)];
        for (const info of sessions) known.add(info.id);
        yield* emit({ _tag: "sessions", sessions });
      });

      /** The agent may remove a file before it is read, which leaves it out. */
      const emitGenerated = Effect.gen(function* () {
        const listed = yield* client.file
          .list({ path: GENERATED_FILES })
          .pipe(Effect.catchTags({ FileNotFoundError: () => Effect.succeed({ data: [] }) }));
        for (const entry of listed.data) {
          if (entry.type !== "file" || generated.has(entry.path)) continue;
          generated.add(entry.path);
          const content = yield* readFile(entry.path).pipe(Effect.option);
          if (Option.isSome(content)) {
            yield* emit({ _tag: "file", path: entry.path, content: content.value });
          }
        }
      });

      /** Pages forward from where the last pass stood, and reads again what may have changed. */
      const readSession = (sessionId: string, touched: ReadonlySet<string>) =>
        Effect.gen(function* () {
          const sessionID = Session.ID.make(sessionId);
          const messages: Array<SessionMessage.Info> = [];
          let cursor = cursors.get(sessionId);
          while (true) {
            const page = yield* client.message.list(
              cursor === undefined ? { sessionID, order: "asc" } : { sessionID, cursor },
            );
            messages.push(...page.data);
            if (page.cursor.next === undefined) break;
            cursor = page.cursor.next;
          }
          if (cursor !== undefined) cursors.set(sessionId, cursor);
          const settled = seen.get(sessionId) ?? new Map<string, boolean>();
          seen.set(sessionId, settled);
          const read = new Set<string>(messages.map((message) => message.id));
          for (const [id, wasSettled] of settled) {
            if (read.has(id) || (wasSettled && !touched.has(id))) continue;
            const message = yield* client.session.message
              .get({ sessionID, messageID: SessionMessage.ID.make(id) })
              .pipe(
                Effect.asSome,
                Effect.catchTags({ MessageNotFoundError: () => Effect.succeedNone }),
              );
            if (Option.isSome(message)) messages.push(message.value);
          }
          if (messages.length === 0) return;
          for (const message of messages) {
            settled.set(message.id, isSettled(message));
            if (message.type === "assistant") {
              for (const part of message.content) {
                if (
                  part.type !== "tool" ||
                  part.name !== "subagent" ||
                  part.state.status !== "completed" ||
                  part.state.metadata?.["status"] !== "running"
                )
                  continue;
                const child = part.state.metadata["sessionID"];
                if (typeof child === "string") add(launches, child, part.id);
              }
            } else if (
              message.type === "synthetic" &&
              message.metadata?.["source"] === "subagent"
            ) {
              const child = message.metadata["childID"];
              if (typeof child === "string") add(reports, child, message.id);
            }
          }
          yield* emitGenerated;
          yield* emit({ _tag: "messages", sessionId: sessionID, messages });
        });

      const readForms = Effect.gen(function* () {
        const forms: Array<Form.Info> = [];
        for (const sessionId of known) {
          forms.push(...(yield* client.session.form.list({ sessionID: sessionId })));
        }
        yield* emit({ _tag: "questions", forms });
      });

      const read = (marked: Marks) =>
        Effect.gen(function* () {
          if ([...marked.sessions.keys()].some((sessionId) => !known.has(sessionId))) {
            marked.tree = true;
          }
          if (marked.tree) yield* readTree;
          for (const [sessionId, touched] of marked.sessions) {
            if (known.has(sessionId)) yield* readSession(sessionId, touched);
          }
          if (marked.forms) yield* readForms;
        });
      /** Reads what events marked since the last pass. */
      const readMarked = Effect.suspend(() => {
        const marked = marks;
        marks = noMarks();
        return read(marked);
      });
      /** Reads every session again: the events naming OpenCode's last writes can arrive late. */
      const readAll = readTree.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            read({
              ...noMarks(),
              forms: true,
              sessions: new Map([...known].map((sessionId) => [sessionId, new Set<string>()])),
            }),
          ),
        ),
      );

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
      /**
       * Every message sent and, by OpenCode's own account, nothing running or waiting and every
       * background subagent reported.
       */
      const done = Effect.gen(function* () {
        for (const message of running.messages.values()) {
          if (message !== null && !sent.has(message.id)) return false;
        }
        if (Object.keys(yield* client.session.active()).length > 0) return false;
        const shells = yield* client.shell.list({});
        if (shells.data.some((shell) => shell.status === "running")) return false;
        for (const sessionId of known) {
          const inbox = yield* client.session.inbox.list({ sessionID: Session.ID.make(sessionId) });
          if (inbox.length > 0) return false;
        }
        return [...launches].every(([child, ids]) => (reports.get(child)?.size ?? 0) >= ids.size);
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
          yield* readMarked;
          if (yield* done) {
            yield* readAll;
            if (yield* done) {
              const info = yield* client.session.get({ sessionID: root });
              return info.outcome === "failed" ? ("failed" as const) : null;
            }
          }
          yield* running.wake.await;
          yield* Effect.sleep("150 millis");
          yield* running.wake.close;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running.attempt = null;
          }),
        ),
      );

      /** Deltas go out as they come; any other event only marks what the next pass reads. */
      const lost = events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "server.connected") yield* connected.open;
            else if (
              event.type === "session.text.delta" ||
              event.type === "session.reasoning.delta"
            ) {
              yield* emit({
                _tag: "delta",
                sessionId: event.data.sessionID,
                messageId: event.data.assistantMessageID,
                ordinal: event.data.ordinal,
                kind: event.type === "session.text.delta" ? "text" : "reasoning",
                delta: event.data.delta,
              });
            } else if (mark(marks, event)) yield* running.wake.open;
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
