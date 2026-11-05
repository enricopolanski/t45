import { type Form, Session, SessionMessage } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/protocol/groups/event";
import { type RunUpdate, isSettled } from "@t45/contracts/resources/Runner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OpenCode from "./OpenCode.ts";

export class StreamEndedError extends Schema.TaggedError<StreamEndedError>()(
  "StreamEndedError",
  {},
) {}

const PAGE = 200;

/** Where the step tools leave the files T45 gets as `file` events. */
const GENERATED_FILES = ".t45/attached";

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

/** False for events that change nothing T45 keeps. */
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

/**
 * What an attempt reads of its VM's OpenCode and sends to T45. The event stream only marks what to
 * read again and forwards deltas, so it never falls behind; it is connected before this returns, so
 * nothing that changes after is missed.
 */
export const make = Effect.fnUntraced(function* ({
  opencode,
  root,
  emit,
  changed,
  ended,
}: {
  readonly opencode: Effect.Success<ReturnType<typeof OpenCode.connect>>;
  readonly root: Session.ID;
  readonly emit: (event: RunUpdate) => Effect.Effect<void>;
  /** Once per batch of events that marked something. */
  readonly changed: Effect.Effect<void>;
  readonly ended: Effect.Effect<void>;
}) {
  const { client, events, readFile } = opencode;
  let marks: Marks = { ...noMarks(), tree: true, forms: true };
  let notified = false;
  const connected = yield* Deferred.make<void, StreamEndedError>();
  yield* events.pipe(
    Stream.runForEach((event) => {
      if (event.type === "server.connected") return Deferred.succeed(connected, undefined);
      if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
        return emit({
          _tag: "delta",
          sessionId: event.data.sessionID,
          messageId: event.data.assistantMessageID,
          ordinal: event.data.ordinal,
          kind: event.type === "session.text.delta" ? "text" : "reasoning",
          delta: event.data.delta,
        });
      }
      if (!mark(marks, event) || notified) return Effect.void;
      notified = true;
      return changed;
    }),
    Effect.exit,
    Effect.tap((exit) =>
      Exit.isFailure(exit)
        ? Effect.logInfo("A VM's event stream ended", { root, cause: exit.cause })
        : Effect.void,
    ),
    Effect.andThen(Deferred.fail(connected, new StreamEndedError())),
    Effect.andThen(ended),
    Effect.forkScoped,
  );
  yield* Deferred.await(connected);

  // What capture saw of each session: its paging cursor, and whether each message was settled.
  const known = new Set<string>([root]);
  const cursors = new Map<string, string>();
  const seen = new Map<string, Map<string, boolean>>();
  // Per subagent session, the background launches (by tool call) and the reports that reached its
  // parent (by message); a session the agent continues launches again.
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
    const sessions = [
      ...all.filter((info) => info.id === root),
      ...OpenCode.sessionsUnder(root, all),
    ];
    for (const info of sessions) known.add(info.id);
    yield* emit({ _tag: "sessions", sessions });
  });

  /** The agent may remove a file before it is read, which leaves it out. */
  const sendGenerated = Effect.gen(function* () {
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

  /** Pages forward from where capture stood, and reads again what may have changed. */
  const captureSession = (sessionId: string, touched: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make(sessionId);
      const messages: Array<SessionMessage.Info> = [];
      let cursor = cursors.get(sessionId);
      while (true) {
        const page = yield* client.message.list(
          cursor === undefined
            ? { sessionID, order: "asc", limit: PAGE }
            : { sessionID, cursor, limit: PAGE },
        );
        messages.push(...page.data);
        if (page.cursor.next === undefined) break;
        cursor = page.cursor.next;
        if (page.data.length < PAGE) break;
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
        } else if (message.type === "synthetic" && message.metadata?.["source"] === "subagent") {
          const child = message.metadata["childID"];
          if (typeof child === "string") add(reports, child, message.id);
        }
      }
      yield* sendGenerated;
      yield* emit({ _tag: "messages", sessionId: sessionID, messages });
    });

  const readForms = Effect.gen(function* () {
    const forms: Array<Form.Info> = [];
    for (const sessionId of known) {
      forms.push(...(yield* client.session.form.list({ sessionID: sessionId })));
    }
    yield* emit({ _tag: "questions", forms });
  });

  const capture = (marked: Marks) =>
    Effect.gen(function* () {
      if ([...marked.sessions.keys()].some((sessionId) => !known.has(sessionId))) {
        marked.tree = true;
      }
      if (marked.tree) yield* readTree;
      for (const [sessionId, touched] of marked.sessions) {
        if (known.has(sessionId)) yield* captureSession(sessionId, touched);
      }
      if (marked.forms) yield* readForms;
    });

  return {
    /** Reads what events marked since the last call. */
    marked: Effect.suspend(() => {
      const marked = marks;
      marks = noMarks();
      notified = false;
      return capture(marked);
    }),
    /** Reads every session again: the events naming OpenCode's last writes can arrive late. */
    all: readTree.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          capture({
            ...noMarks(),
            forms: true,
            sessions: new Map([...known].map((sessionId) => [sessionId, new Set<string>()])),
          }),
        ),
      ),
    ),
    /** By OpenCode's own account: nothing running or waiting, every background subagent reported. */
    idle: Effect.gen(function* () {
      if (Object.keys(yield* client.session.active()).length > 0) return false;
      const shells = yield* client.shell.list({});
      if (shells.data.some((shell) => shell.status === "running")) return false;
      for (const sessionId of known) {
        const inbox = yield* client.session.inbox.list({ sessionID: Session.ID.make(sessionId) });
        if (inbox.length > 0) return false;
      }
      return [...launches].every(([child, ids]) => (reports.get(child)?.size ?? 0) >= ids.size);
    }),
  };
});
