import { type Form, Model, OpenCode, Session, SessionMessage } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/protocol/groups/event";
import {
  AnswerInvalid,
  ExecutionFailed,
  type ExecutionRequest,
  type ExecutionUpdate,
  isSettled,
  QuestionGone,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as SandboxManager from "./SandboxManager.ts";
import { applyCapabilities, type AgentSetup } from "./AgentSetup.ts";

const createOpencodeClient = Effect.fnUntraced(function* (
  url: string,
  password: Redacted.Redacted,
  agent: AgentSetup,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.basicAuth("opencode", password)),
    HttpClient.transformResponse(
      Effect.map((response) => {
        if (!response.headers["content-type"]?.startsWith("text/event-stream")) return response;
        // Opencode sends heartbeats every 15, after 45 we kill the stream.
        return Object.defineProperty(response, "stream", {
          value: response.stream.pipe(Stream.timeout("45 seconds")),
        });
      }),
    ),
  );
  const client = yield* OpenCode.make({ baseUrl: url }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  yield* client.server.info().pipe(
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeout("1 minute"),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new ExecutionFailed({ reason: "The agent's OpenCode didn't start within a minute." }),
        ),
    }),
  );
  // OpenCode answers before its MCP servers connect, and a turn started then finds no tools.
  // A disabled server never connects.
  const servers = Object.entries(agent.mcpServers)
    .filter(([, server]) => server.disabled !== true)
    .map(([name]) => name);
  if (servers.length > 0) {
    const unconnected = ({ data }: Effect.Success<ReturnType<typeof client.mcp.list>>) =>
      servers.flatMap((name) => {
        const status = data.find((server) => server.name === name)?.status;
        if (status?.status === "connected") return [];
        return [
          status === undefined
            ? `${name} (not started)`
            : "error" in status
              ? `${name} (${status.status}: ${status.error})`
              : `${name} (${status.status})`,
        ];
      });
    yield* client.mcp.list().pipe(
      Effect.filterOrFail((listed) => unconnected(listed).length === 0),
      Effect.retry(Schedule.spaced("500 millis")),
      Effect.timeout("1 minute"),
      Effect.catchTags({
        TimeoutError: () =>
          client.mcp.list().pipe(
            Effect.flatMap((listed) =>
              Effect.fail(
                new ExecutionFailed({
                  reason: `The agent's tools didn't connect within a minute: ${unconnected(listed).join(", ")}.`,
                }),
              ),
            ),
          ),
      }),
    );
  }
  return client;
});

type OpencodeClient = Effect.Success<ReturnType<typeof createOpencodeClient>>;

class StreamEndedError extends Schema.TaggedError<StreamEndedError>()("StreamEndedError", {}) {}

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

/** What changed since the last pass and has to be fetched again: events only say where to look. */
class PendingReads {
  /** Each session's messages, with the message ids its events named. */
  readonly messagesToRead = new Map<string, Set<string>>();

  shouldReadSessionList: boolean;
  shouldReadQuestions: boolean;

  constructor(shouldReadSessionList = false, shouldReadQuestions = false) {
    this.shouldReadSessionList = shouldReadSessionList;
    this.shouldReadQuestions = shouldReadQuestions;
  }

  get isEmpty() {
    return (
      !this.shouldReadSessionList && !this.shouldReadQuestions && this.messagesToRead.size === 0
    );
  }

  add(event: OpenCodeEvent) {
    const type = event.type;
    if (type.startsWith("form.")) {
      this.shouldReadQuestions = true;
      return;
    }
    if (!type.startsWith("session.") || IGNORED.has(type)) return;
    if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return;
    if (type === "session.created" || type === "session.deleted" || type === "session.renamed") {
      this.shouldReadSessionList = true;
      return;
    }
    const touched = this.messagesToRead.get(event.data.sessionID) ?? new Set<string>();
    const id =
      ("assistantMessageID" in event.data ? event.data.assistantMessageID : undefined) ??
      ("inboxID" in event.data ? event.data.inboxID : undefined);
    if (typeof id === "string") touched.add(id);
    this.messagesToRead.set(event.data.sessionID, touched);
  }
}

/**
 * Turns the events' hints into authoritative emits: the chat's sessions, each session's new or
 * changed messages and the open questions. It remembers what
 * it read so a pass only emits what changed, and tells when OpenCode has finished everything.
 */
const createOpencodeReader = (
  client: OpencodeClient,
  rootId: Session.ID,
  emit: (event: ExecutionUpdate) => Effect.Effect<void>,
) => {
  /** The root and every session listed since. */
  const known = new Set<string>([rootId]);
  /** Where paging each session's messages stood after the last read. */
  const cursors = new Map<string, string>();
  /** Per session, the messages still streaming, read again until they settle. */
  const unfinished = new Map<string, Set<string>>();
  // Per subagent session, the background launches (by tool call) and the reports that reached
  // its parent (by message); a session the agent continues launches again.
  const launches = new Map<string, Set<string>>();
  const reports = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, child: string, id: string) =>
    map.set(child, (map.get(child) ?? new Set()).add(id));

  /** A VM is one chat's, so every session in it is the chat's. */
  const readSessionList = Effect.gen(function* () {
    // Without a cap on `limit`, one answer holds every session.
    const { data: sessions } = yield* client.session.list({
      order: "asc",
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const info of sessions) known.add(info.id);
    yield* emit({ _tag: "sessions", sessions });
  });

  /** Pages forward from where the last pass stood, and reads again what may have changed. */
  const readSession = Effect.fnUntraced(function* (
    sessionId: string,
    touched: ReadonlySet<string>,
  ) {
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
        .pipe(Effect.asSome, Effect.catchTags({ MessageNotFoundError: () => Effect.succeedNone }));
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
      } else if (message.type === "synthetic" && message.metadata?.["source"] === "subagent") {
        const child = message.metadata["childID"];
        if (typeof child === "string") add(reports, child, message.id);
      }
    }
    yield* emit({ _tag: "messages", sessionId: sessionID, messages });
  });

  const readForms = Effect.gen(function* () {
    const forms: Array<Form.Info> = [];
    for (const sessionId of known) {
      forms.push(...(yield* client.session.form.list({ sessionID: sessionId })));
    }
    yield* emit({ _tag: "questions", forms });
  });

  /**
   * Every message sent and, by OpenCode's own account, nothing running or waiting and every
   * background subagent reported.
   */
  const isDone = Effect.gen(function* () {
    if (Object.keys(yield* client.session.active()).length > 0) return false;
    const shells = yield* client.shell.list({});
    if (shells.data.some((shell) => shell.status === "running")) return false;
    for (const sessionId of known) {
      const inbox = yield* client.session.inbox.list({ sessionID: Session.ID.make(sessionId) });
      if (inbox.length > 0) return false;
    }
    return [...launches].every(([child, ids]) => (reports.get(child)?.size ?? 0) >= ids.size);
  });

  return { known: known as ReadonlySet<string>, readSessionList, readSession, readForms, isDone };
};

export const layer = RunnerRpcs.toLayer(
  Effect.sync(() => {
    const activeExecutions = new Map<
      string,
      {
        readonly opencodeClient: OpencodeClient;
        readonly writeFiles: (
          files: ExecutionRequest["files"],
        ) => Effect.Effect<void, SandboxManager.SandboxError>;
      }
    >();

    const execute = Effect.fnUntraced(function* (
      request: ExecutionRequest,
      emit: (event: ExecutionUpdate) => Effect.Effect<void>,
    ) {
      const rootId = request.rootId;
      const agent = applyCapabilities(request);
      const mailbox = yield* Queue.unbounded<OpenCodeEvent>();
      yield* emit({ _tag: "heartbeat" }).pipe(
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.forkScoped,
      );
      const sandbox = yield* SandboxManager.start(
        rootId,
        agent,
        request.disk,
        request.serverUrl,
        request.toolToken,
      );
      const opencodeClient = yield* createOpencodeClient(
        `http://127.0.0.1:${sandbox.port}`,
        sandbox.password,
        agent,
      );

      const eventsStream = opencodeClient.event.subscribe();

      const reader = createOpencodeReader(opencodeClient, rootId, emit);
      let pendingReads = new PendingReads(true, true);

      const writeFiles = (files: ExecutionRequest["files"]) =>
        Effect.gen(function* () {
          for (const [path, content] of Object.entries(files)) yield* sandbox.write(path, content);
        });
      /** Until OpenCode is done with every message; returns the rootId's outcome. */
      const startAndTrackSession = Effect.gen(function* () {
        yield* writeFiles(request.files);
        const model = Model.Ref.parse(request.agent.model);
        yield* opencodeClient.session.create({
          id: rootId,
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
        yield* opencodeClient.session.switchModel({ sessionID: rootId, model });
        for (const message of request.messages) {
          yield* opencodeClient.session.prompt({
            ...message,
            sessionID: rootId,
            delivery: "queue",
          });
        }
        const execution = { opencodeClient, writeFiles };
        activeExecutions.set(rootId, execution);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (activeExecutions.get(rootId) === execution) activeExecutions.delete(rootId);
          }),
        );
        while (true) {
          for (const event of yield* Queue.clear(mailbox)) pendingReads.add(event);
          if (
            pendingReads.shouldReadSessionList ||
            [...pendingReads.messagesToRead.keys()].some(
              (sessionId) => !reader.known.has(sessionId),
            )
          )
            yield* reader.readSessionList;
          for (const [sessionId, touched] of pendingReads.messagesToRead) {
            if (reader.known.has(sessionId)) yield* reader.readSession(sessionId, touched);
          }
          if (pendingReads.shouldReadQuestions) yield* reader.readForms;
          pendingReads = new PendingReads();
          if (yield* reader.isDone) {
            // Events naming OpenCode's last writes can arrive late.
            yield* reader.readSessionList;
            for (const sessionId of reader.known) yield* reader.readSession(sessionId, new Set());
            yield* reader.readForms;
            if (yield* reader.isDone) {
              const info = yield* opencodeClient.session.get({ sessionID: rootId });
              return info.outcome === "failed" ? ("failed" as const) : null;
            }
          }
          // Ignored events do not need another pass; a shell event reads nothing, but `done` asks about shells.
          while (true) {
            const event = yield* Queue.take(mailbox);
            pendingReads.add(event);
            if (!pendingReads.isEmpty || event.type.startsWith("shell.")) break;
          }
        }
      });

      // Keep the subscription alive from `server.connected` through the final reads, then close it before saving the VM.
      const rootSessionOutcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const [first, remaining] = yield* Stream.peel(eventsStream, Sink.head());
          if (Option.isNone(first) || first.value.type !== "server.connected")
            return yield* new StreamEndedError();
          const receive = remaining.pipe(
            Stream.runForEach((event) =>
              event.type === "session.text.delta" || event.type === "session.reasoning.delta"
                ? emit({
                    _tag: "delta",
                    sessionId: event.data.sessionID,
                    messageId: event.data.assistantMessageID,
                    ordinal: event.data.ordinal,
                    kind: event.type === "session.text.delta" ? "text" : "reasoning",
                    delta: event.data.delta,
                  })
                : Queue.offer(mailbox, event),
            ),
            Effect.andThen(Effect.fail(new StreamEndedError())),
          );
          return yield* Effect.raceFirst(startAndTrackSession, receive);
        }),
      );
      yield* emit({
        _tag: "finished",
        outcome: rootSessionOutcome,
        disk: yield* sandbox.save,
      });
    });

    return RunnerRpcs.of({
      execute: (request) =>
        Stream.callback((queue) =>
          execute(request, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              Effect.logError("An execution failed", { rootId: request.rootId, error }),
            ),
            Effect.mapError((error) =>
              error._tag === "ExecutionFailed"
                ? error
                : new ExecutionFailed({
                    reason: `The runner failed: ${"message" in error && error.message ? error.message : error._tag}.`,
                  }),
            ),
            Effect.andThen(Queue.end(queue)),
          ),
        ),
      send: ({ rootId, message, files }) =>
        Effect.gen(function* () {
          const execution = activeExecutions.get(rootId);
          if (execution === undefined) return;
          yield* execution.writeFiles(files);
          yield* execution.opencodeClient.session.prompt({
            ...message,
            sessionID: rootId,
            delivery: "queue",
          });
        }).pipe(Effect.orDie),
      cancel: ({ rootId, messageId }) =>
        Effect.suspend(() => {
          const execution = activeExecutions.get(rootId);
          if (execution === undefined) return Effect.void;
          return execution.opencodeClient.session.inbox
            .cancel({ sessionID: rootId, inboxID: messageId })
            .pipe(Effect.orDie);
        }),
      answer: ({ rootId, sessionId, formId, answer, files }) =>
        Effect.gen(function* () {
          const execution = activeExecutions.get(rootId);
          if (execution === undefined) return yield* new QuestionGone();
          yield* execution.writeFiles(files).pipe(Effect.orDie);
          yield* execution.opencodeClient.session.form
            .reply({ sessionID: sessionId, formID: formId, answer })
            .pipe(
              Effect.catchTags(
                {
                  FormInvalidAnswerError: () => new AnswerInvalid(),
                  FormAlreadySettledError: () => new QuestionGone(),
                  FormNotFoundError: () => new QuestionGone(),
                  SessionNotFoundError: () => new QuestionGone(),
                },
                Effect.die,
              ),
            );
        }),
      dismiss: ({ rootId, sessionId, formId }) =>
        Effect.suspend(() => {
          const execution = activeExecutions.get(rootId);
          if (execution === undefined) return new QuestionGone();
          return execution.opencodeClient.session.form
            .cancel({ sessionID: sessionId, formID: formId })
            .pipe(
              Effect.catchTags(
                {
                  FormAlreadySettledError: () => new QuestionGone(),
                  FormNotFoundError: () => new QuestionGone(),
                  SessionNotFoundError: () => new QuestionGone(),
                },
                Effect.die,
              ),
            );
        }),
    });
  }),
);
