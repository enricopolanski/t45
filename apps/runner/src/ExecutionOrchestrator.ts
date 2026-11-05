import {
  type Form,
  Model,
  OpenCode,
  type OpenCodeClient,
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
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SandboxManager from "./SandboxManager.ts";

type ControlRpc = Exclude<RpcGroup.Rpcs<typeof RunnerRpcs>, { readonly _tag: "execute" }>;
type ExecutionHandlers = {
  readonly [R in ControlRpc as R["_tag"]]: (
    input: Rpc.Payload<R>,
  ) => Effect.Effect<void, Rpc.Error<R>>;
};

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeEvent));

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
    Effect.provideService(HttpClient.HttpClient, authenticated),
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

/** OpenCode answers before its MCP servers connect, and a turn started then finds no tools. */
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

/** The event stream ended before OpenCode finished. */
class StreamEndedError extends Schema.TaggedError<StreamEndedError>()("StreamEndedError", {}) {}

/** Sessions to read again, with the messages events named. */
const noMarks = () => ({ tree: false, forms: false, sessions: new Map<string, Set<string>>() });

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
const mark = (marks: ReturnType<typeof noMarks>, event: OpenCodeEvent): boolean => {
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
const sessionsUnder = (root: Session.ID, sessions: ReadonlyArray<Session.Info>) => {
  const children = Map.groupBy(sessions, (session) => session.parentID);
  const under: Array<Session.Info> = [];
  const seen = new Set([root]);
  const parents = [root];
  for (const parent of parents) {
    for (const child of children.get(parent) ?? []) {
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
    const controls = new Map<string, ExecutionHandlers>();

    /**
     * In a new sandbox, removed when it ends, whose disk is saved once OpenCode is done with every
     * message. Fails when the sandbox is lost.
     */
    const execute = Effect.fnUntraced(function* (
      id: string,
      request: ExecutionRequest,
      emit: (event: ExecutionUpdate) => Effect.Effect<void>,
    ) {
      let active = false;
      const root = request.root;
      /** Null after delivery or cancellation, so a duplicate send cannot deliver it again. */
      const inputs = new Map<string, { message: Message; files: ExecutionRequest["files"] } | null>(
        request.messages.map((message) => [message.id, { message, files: {} }]),
      );
      const wake = yield* Latch.make();
      const lock = yield* Semaphore.make(1);
      // Inputs can arrive during startup; only active executions can use the sandbox below.
      const handlers: ExecutionHandlers = {
        send: ({ message, files }) =>
          Effect.suspend(() => {
            if (inputs.has(message.id)) return Effect.void;
            inputs.set(message.id, { message, files });
            return wake.open.pipe(Effect.asVoid);
          }),
        cancel: ({ messageId }) =>
          lock.withPermit(
            Effect.gen(function* () {
              const input = inputs.get(messageId);
              inputs.set(messageId, null);
              if (!active || input !== null) return;
              yield* client.session.inbox
                .cancel({ sessionID: root, inboxID: messageId })
                .pipe(Effect.ignore);
            }),
          ),
        answer: ({ sessionId, formId, answer, files }) =>
          Effect.gen(function* () {
            if (!active) return yield* new QuestionGone();
            yield* writeFiles(files);
            yield* client.session.form.reply({ sessionID: sessionId, formID: formId, answer });
          }).pipe(
            Effect.mapError((error) =>
              error._tag === "FormInvalidAnswerError" ? new AnswerInvalid() : new QuestionGone(),
            ),
          ),
        dismiss: ({ sessionId, formId }) =>
          Effect.suspend(() =>
            active
              ? client.session.form
                  .cancel({ sessionID: sessionId, formID: formId })
                  .pipe(Effect.mapError(() => new QuestionGone()))
              : new QuestionGone(),
          ),
      };
      controls.set(id, handlers);
      const close = () => {
        active = false;
        if (controls.get(id) === handlers) controls.delete(id);
      };
      yield* Effect.addFinalizer(() => Effect.sync(close));
      yield* emit({ _tag: "heartbeat" }).pipe(
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.forkScoped,
      );
      const sandbox = yield* start(id, request.agent, request.disk);
      const { client, events, readFile } = yield* connect(
        `http://127.0.0.1:${sandbox.port}`,
        sandbox.password,
      );
      yield* ready(client, request.agent);

      // Events mark the next reads; unfinished messages are read again until they settle.
      let marks = { ...noMarks(), tree: true, forms: true };
      const known = new Set<string>([root]);
      const cursors = new Map<string, string>();
      const unfinished = new Map<string, Set<string>>();
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
          .list({ path: ".t45/attached" })
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
          const pending = unfinished.get(sessionId) ?? new Set<string>();
          unfinished.set(sessionId, pending);
          const read = new Set<string>(messages.map((message) => message.id));
          for (const id of new Set([...pending, ...touched])) {
            if (read.has(id)) continue;
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
            if (isSettled(message)) pending.delete(message.id);
            else pending.add(message.id);
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

      const written = new Set<string>();
      /** One the sandbox refuses is skipped. */
      const writeFiles = (files: ExecutionRequest["files"]) =>
        Effect.gen(function* () {
          for (const [path, content] of Object.entries(files)) {
            if (written.has(path)) continue;
            yield* sandbox
              .write(path, content)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Writing a file into a sandbox failed", { id, path, error }),
                ),
              );
            written.add(path);
          }
        });
      const deliver = lock.withPermit(
        Effect.gen(function* () {
          for (const input of inputs.values()) {
            if (input === null) continue;
            const { message, files } = input;
            yield* writeFiles(files);
            yield* client.session.prompt({ ...message, sessionID: root, delivery: "queue" });
            inputs.set(message.id, null);
          }
        }),
      );
      /**
       * Every message sent and, by OpenCode's own account, nothing running or waiting and every
       * background subagent reported.
       */
      const done = Effect.gen(function* () {
        if ([...inputs.values()].some((input) => input !== null)) return false;
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
        yield* writeFiles(request.files);
        const model = Model.Ref.parse(request.agent.model);
        yield* client.session.create({
          id: root,
          title: request.title,
          model,
          // Session permissions override the agent's ones.
          // Allow tools without approval; commands and file access run safely inside the sandbox.
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            ...(request.allowQuestions
              ? []
              : [{ action: "question", resource: "*", effect: "deny" } as const]),
          ],
        });
        yield* client.session.switchModel({ sessionID: root, model });
        active = true;
        while (true) {
          yield* deliver;
          const marked = marks;
          marks = noMarks();
          if (
            marked.tree ||
            [...marked.sessions.keys()].some((sessionId) => !known.has(sessionId))
          ) {
            yield* readTree;
          }
          for (const [sessionId, touched] of marked.sessions) {
            if (known.has(sessionId)) yield* readSession(sessionId, touched);
          }
          if (marked.forms) yield* readForms;
          if (yield* done) {
            // Read every session again: events naming OpenCode's last writes can arrive late.
            yield* readTree;
            for (const sessionId of known) yield* readSession(sessionId, new Set());
            yield* readForms;
            if (yield* done) {
              const info = yield* client.session.get({ sessionID: root });
              if ([...inputs.values()].every((input) => input === null)) {
                close();
                return info.outcome === "failed" ? ("failed" as const) : null;
              }
            }
          }
          yield* wake.await;
          yield* Effect.sleep("150 millis");
          yield* wake.close;
        }
      });

      /** Deltas go out as they come; any other event only marks what the next pass reads. */
      const consumeEvents = events.pipe(
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
            } else if (mark(marks, event)) yield* wake.open;
          }),
        ),
        Effect.andThen(Effect.fail(new StreamEndedError())),
      );

      // The loser is interrupted before the race returns, so the stream is gone before `save`
      // removes the VM.
      const outcome = yield* Effect.raceFirst(converse, consumeEvents);
      yield* emit({ _tag: "finished", outcome, disk: yield* sandbox.save });
    });

    return RunnerRpcs.of({
      execute: ({ id, request }) =>
        Stream.callback((queue) =>
          execute(id, request, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
            Effect.scoped,
            Effect.tapError((error) => Effect.logError("An execution failed", { id, error })),
            Effect.orDie,
            Effect.andThen(Queue.end(queue)),
          ),
        ),
      send: (input) => Effect.suspend(() => controls.get(input.id)?.send(input) ?? Effect.void),
      cancel: (input) => Effect.suspend(() => controls.get(input.id)?.cancel(input) ?? Effect.void),
      answer: (input) =>
        Effect.suspend(() => controls.get(input.id)?.answer(input) ?? new QuestionGone()),
      dismiss: (input) =>
        Effect.suspend(() => controls.get(input.id)?.dismiss(input) ?? new QuestionGone()),
    });
  }),
);
