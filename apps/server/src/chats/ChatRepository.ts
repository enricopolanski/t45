/**
 * What T45 stores for its chats: the chats, their OpenCode sessions and messages, the inputs
 * sent to them, the questions waiting for an answer, and the agent's saved workspace, whose
 * tarball is a file in the server's state folder.
 */
import { Form, Session, SessionMessage } from "@opencode/client/effect";
import type * as Statement from "effect/sql/Statement";
import { ChatOrigin, Task, TaskState, Trigger } from "@t45/contracts/models/Task";
import type { Agent } from "@t45/contracts/models/Agent";
import {
  Chat,
  type ChatId,
  type ChatStatus,
  Input,
  type InputId,
  InputPayload,
  type InputState,
} from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { Member } from "./ChatService.ts";
import * as ServerConfig from "../config.ts";
import { inputIdOf, rootSessionId } from "./ChatIds.ts";

export interface StopRequest {
  readonly through: number;
}

const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  parentSessionId: Schema.NullOr(Schema.String),
  info: Schema.fromJsonString(Session.Info),
  tailCursor: Schema.NullOr(Schema.String),
});
export type SessionRow = typeof SessionRow.Type;

export interface MessageRow {
  readonly sessionId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly type: string;
  readonly state: "live" | "settled" | "lost";
  readonly json: string;
}

const QuestionRow = Schema.Struct({
  sessionId: Session.ID,
  form: Schema.fromJsonString(Form.Info),
  askedAt: Schema.String,
});
type QuestionRow = typeof QuestionRow.Type;

interface LostMessage {
  readonly sessionId: string;
  readonly message: SessionMessage.Info;
}

/** What one captured page changed: the messages written and whether inputs materialized. */
export interface Captured {
  readonly messageIds: ReadonlyArray<string>;
  readonly inputsChanged: boolean;
}

const decodeOrigin = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatOrigin));
const encodeTrigger = Schema.encodeSync(Schema.fromJsonString(Trigger));
const encodeState = Schema.encodeSync(Schema.fromJsonString(TaskState));

const makeOrigins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = (where: Statement.Fragment) =>
    sql<{ readonly origin: string }>`SELECT json_object('chatId', chat_id,
      'kind', CASE WHEN owner_user_id IS NULL THEN 'task' ELSE 'conversation' END,
      'ownerUserId', owner_user_id, 'trigger', json(trigger), 'state', json(state)) AS origin
      FROM chat_origins WHERE ${where}`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeOrigin(row.origin))),
      Effect.orDie,
    );
  const get = (chatId: ChatId) =>
    select(sql`chat_id = ${chatId}`).pipe(Effect.map((rows) => rows[0] ?? null));
  const tasks = (where: Statement.Fragment) =>
    select(sql`trigger IS NOT NULL AND ${where}`).pipe(
      Effect.map((rows) => rows.filter((row): row is Task => row.kind === "task")),
    );
  return {
    get,
    insert: (origin: ChatOrigin) =>
      sql`INSERT INTO chat_origins (chat_id, owner_user_id, trigger, state)
      VALUES (${origin.chatId}, ${origin.kind === "conversation" ? origin.ownerUserId : null},
        ${origin.kind === "task" ? encodeTrigger(origin.trigger) : null},
        ${origin.kind === "task" ? encodeState(origin.state) : null})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    setState: (chatId: ChatId, state: TaskState) =>
      sql`UPDATE chat_origins SET state = ${encodeState(state)}
      WHERE chat_id = ${chatId} AND trigger IS NOT NULL`.pipe(Effect.asVoid, Effect.orDie),
    nonterminal: tasks(sql`json_extract(state, '$.type') <> 'settled'`),
    listByTrigger: (reference: { readonly ticketId: string; readonly stepId: string }) =>
      tasks(
        sql`json_extract(trigger, '$.ticketId') = ${reference.ticketId} AND json_extract(trigger, '$.stepId') = ${reference.stepId}`,
      ),
    recordedCalls: (chatId: ChatId, keys: ReadonlyArray<string>) =>
      keys.length === 0
        ? Effect.succeed(new Set<string>())
        : sql<{ readonly key: string }>`SELECT call_key AS key FROM task_calls
        WHERE chat_id = ${chatId} AND ${sql.in("call_key", keys)}`.pipe(
            Effect.map((rows) => new Set(rows.map((row) => row.key))),
            Effect.orDie,
          ),
    recordCall: (chatId: ChatId, key: string) =>
      sql`INSERT INTO task_calls (chat_id, call_key) VALUES (${chatId}, ${key})
      ON CONFLICT DO NOTHING RETURNING call_key`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
  };
});

const CHAT_COLUMNS = `id, agent_id AS "agentId", title, status, updated_at AS "lastActivityAt"`;

const decodeChat = Schema.decodeUnknownEffect(Chat);
const decodeChats = Schema.decodeUnknownEffect(Schema.Array(Chat));
const decodeWorker = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...Chat.fields,
    vm: Schema.Literals(["awake", "asleep"]),
    bootId: Schema.NullOr(Schema.String),
  }),
);

const MESSAGE_COLUMNS = `session_id AS "sessionId", message_id AS "messageId", ordinal, type,
  state, json`;

const QUESTION_COLUMNS = `session_id AS "sessionId", form_json AS "form", asked_at AS "askedAt"`;

const SESSION_COLUMNS = `session_id AS "sessionId", parent_session_id AS "parentSessionId",
  info_json AS "info", tail_cursor AS "tailCursor"`;

const INPUT_COLUMNS = `input_id AS "inputId", ordinal, state, payload_json AS "payload",
  created_at AS "createdAt"`;

const decodeInputs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...Input.fields, payload: Schema.fromJsonString(InputPayload) })),
);

const inputsOf = (rows: ReadonlyArray<unknown>) => decodeInputs(rows).pipe(Effect.orDie);
const encodePayload = Schema.encodeSync(Schema.fromJsonString(InputPayload));

const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow));
const encodeSessionInfo = Schema.encodeSync(Schema.fromJsonString(Session.Info));

const decodeQuestions = Schema.decodeUnknownEffect(Schema.Array(QuestionRow));
const encodeForm = Schema.encodeSync(Schema.fromJsonString(Form.Info));

const MessageJson = Schema.fromJsonString(SessionMessage.Info);
const encodeMessage = Schema.encodeSync(MessageJson);
const decodeMessageJson = Schema.decodeEffect(MessageJson);
const decodeMessage = (json: string) => decodeMessageJson(json).pipe(Effect.orDie);

/**
 * Whether OpenCode finished writing the message, by its own rule: an assistant once completed, a
 * shell or compaction once it stopped running, anything else once it exists. Import keeps only
 * these.
 */
const isSettled = (message: SessionMessage.Info) => {
  switch (message.type) {
    case "assistant":
      return message.time.completed !== undefined;
    case "shell":
    case "compaction":
      return message.status !== "running";
    default:
      return true;
  }
};

/** Above this many messages a restore imports from the latest completed compaction. */
const IMPORT_CUT_MESSAGES = 4_000;

/** Where chats' workspace tarballs are kept, under the server's state folder. */
const WORKSPACES_DIRECTORY = "chat-workspaces";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const workspacesDir = path.join(stateDir, WORKSPACES_DIRECTORY);
  const workspaceFile = (chatId: ChatId) => path.join(workspacesDir, `${chatId}.tar.gz`);

  const origins = yield* makeOrigins;
  const chatColumns = sql.literal(CHAT_COLUMNS);
  const inputColumns = sql.literal(INPUT_COLUMNS);
  const messageColumns = sql.literal(MESSAGE_COLUMNS);
  const questionColumns = sql.literal(QUESTION_COLUMNS);
  const sessionColumns = sql.literal(SESSION_COLUMNS);

  const get = (chatId: ChatId) =>
    sql`SELECT ${chatColumns} FROM chats WHERE id = ${chatId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeChat(row))),
      Effect.orDie,
    );

  /**
   * Writes messages OpenCode returned for a session, new ones after the ones it has, with the
   * tail cursor and the inputs they deliver; callers hold the transaction.
   */
  const captureIn = (
    chatId: ChatId,
    sessionId: string,
    messages: ReadonlyArray<SessionMessage.Info>,
    tailCursor: string | undefined,
  ) =>
    Effect.gen(function* () {
      const ids = messages.map((message) => message.id);
      const known = new Set(
        ids.length === 0
          ? []
          : (yield* sql<{ readonly id: string }>`SELECT message_id AS id FROM chat_messages
              WHERE chat_id = ${chatId} AND session_id = ${sessionId}
                AND ${sql.in("message_id", ids)}`).map((row) => row.id),
      );
      const [next] = yield* sql<{ readonly next: number }>`SELECT next_ordinal AS next
        FROM chat_sessions WHERE chat_id = ${chatId} AND session_id = ${sessionId}`;
      let ordinal = next?.next ?? 0;
      const written: Array<string> = [];
      for (const message of messages) {
        const json = encodeMessage(message);
        const state = isSettled(message) ? "settled" : "live";
        const changed = yield* sql<{ readonly id: string }>`INSERT INTO chat_messages
            (chat_id, session_id, message_id, ordinal, type, state, json)
          VALUES (${chatId}, ${sessionId}, ${message.id},
            ${known.has(message.id) ? -1 : ordinal}, ${message.type}, ${state}, ${json})
          ON CONFLICT (chat_id, session_id, message_id) DO UPDATE SET
            type = excluded.type, state = excluded.state, json = excluded.json
            WHERE chat_messages.json IS NOT excluded.json
              OR chat_messages.state IS NOT excluded.state
          RETURNING message_id AS id`;
        if (!known.has(message.id)) {
          known.add(message.id);
          ordinal += 1;
        }
        if (changed.length > 0) written.push(message.id);
      }
      yield* sql`UPDATE chat_sessions SET next_ordinal = ${ordinal},
          tail_cursor = COALESCE(${tailCursor ?? null}, tail_cursor)
        WHERE chat_id = ${chatId} AND session_id = ${sessionId}`;
      // A user message admitted under an input's id is that input, delivered.
      const inputIds = messages.flatMap((message) => {
        const inputId = message.type === "user" ? inputIdOf(chatId, message.id) : null;
        return inputId === null ? [] : [inputId];
      });
      const materialized =
        inputIds.length === 0
          ? []
          : yield* sql`UPDATE chat_inputs SET state = 'materialized'
              WHERE chat_id = ${chatId} AND ${sql.in("input_id", inputIds)}
                AND state <> 'materialized'
              RETURNING input_id`;
      return {
        messageIds: written,
        inputsChanged: materialized.length > 0,
      } satisfies Captured;
    });

  return {
    get,
    origins,
    workerRow: (chatId: ChatId) =>
      sql`SELECT ${chatColumns}, vm, boot_id AS "bootId" FROM chats WHERE id = ${chatId} AND deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeWorker(row))),
        Effect.orDie,
      ),
    insert: (row: {
      readonly id: ChatId;
      readonly agentId: Agent["id"];
      readonly title: string | null;
      readonly at: string;
    }) =>
      sql`INSERT INTO chats (id, agent_id, title, created_at, updated_at)
        VALUES (${row.id}, ${row.agentId}, ${row.title},
          ${row.at}, ${row.at})
        ON CONFLICT (id) DO NOTHING`.pipe(Effect.asVoid, Effect.orDie),
    list: (member: Member) =>
      sql`SELECT ${chatColumns} FROM chats WHERE deleted_at IS NULL AND id IN (SELECT chat_id FROM chat_origins
        WHERE owner_user_id = ${member.userId} OR (trigger IS NOT NULL AND ${member.role === "admin"})) ORDER BY updated_at DESC, id DESC`.pipe(
        Effect.flatMap(decodeChats),
        Effect.orDie,
      ),
    exists: (chatId: ChatId) =>
      sql`SELECT id FROM chats WHERE id = ${chatId}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    rename: (chatId: ChatId, title: string) =>
      sql`UPDATE chats SET title = ${title} WHERE id = ${chatId}`.pipe(Effect.asVoid, Effect.orDie),
    setTitleIfUntitled: (chatId: ChatId, title: string) =>
      sql`UPDATE chats SET title = ${title} WHERE id = ${chatId} AND title IS NULL`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    setSummary: (
      chatId: ChatId,
      summary: {
        readonly status: ChatStatus | null;
        readonly lastActivityAt: string | null;
      },
    ) =>
      sql<{ readonly id: string }>`UPDATE chats SET
          status = ${summary.status},
          updated_at = COALESCE(${summary.lastActivityAt}, created_at)
        WHERE id = ${chatId}
          AND (status IS NOT ${summary.status}
            OR updated_at IS NOT COALESCE(${summary.lastActivityAt}, created_at))
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    markRunning: (chatId: ChatId) =>
      sql`UPDATE chats SET status = 'running' WHERE id = ${chatId} AND status IS NOT 'waiting'`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    setVm: (chatId: ChatId, vm: "awake" | "asleep") =>
      sql`UPDATE chats SET vm = ${vm} WHERE id = ${chatId}`.pipe(Effect.asVoid, Effect.orDie),
    setBoot: (chatId: ChatId, bootId: string | null) =>
      sql`UPDATE chats SET boot_id = ${bootId} WHERE id = ${chatId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    needingWorker: (includeFailed: boolean) =>
      sql<{ readonly id: ChatId; readonly hasStop: number }>`SELECT id,
          stop_through IS NOT NULL AS "hasStop"
        FROM chats
        WHERE deleted_at IS NULL AND (
          stop_through IS NOT NULL OR vm = 'awake'
          OR ((${includeFailed ? 1 : 0} OR status IS NOT 'failed')
            AND EXISTS (SELECT 1 FROM chat_inputs i
              WHERE i.chat_id = chats.id AND i.state IN ('waiting', 'admitted'))))
        ORDER BY id`.pipe(
        Effect.map((rows) => rows.map((row) => ({ id: row.id, hasStop: row.hasStop === 1 }))),
        Effect.orDie,
      ),
    requestStop: (chatId: ChatId) =>
      sql`UPDATE chats SET stop_through = MAX(COALESCE(stop_through, -1),
          (SELECT COALESCE(MAX(ordinal), -1) FROM chat_inputs WHERE chat_id = ${chatId}))
        WHERE id = ${chatId} AND deleted_at IS NULL
        RETURNING ${chatColumns}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeChat(row))),
        Effect.orDie,
      ),
    stopRequest: (chatId: ChatId) =>
      sql<StopRequest>`SELECT stop_through AS through
        FROM chats WHERE id = ${chatId} AND stop_through IS NOT NULL`.pipe(
        Effect.map(([row]) => row ?? null),
        Effect.orDie,
      ),
    clearStop: (chatId: ChatId, stop: StopRequest) =>
      sql<{ readonly id: string }>`UPDATE chats SET stop_through = NULL
        WHERE id = ${chatId} AND stop_through = ${stop.through}
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    markDeleted: (chatId: ChatId, at: string) =>
      sql<{ readonly id: string }>`UPDATE chats SET deleted_at = ${at}, cleanup_pending = 1,
          vm = 'asleep'
        WHERE id = ${chatId}
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    pendingDeletes: sql<{ readonly id: ChatId }>`SELECT id FROM chats WHERE cleanup_pending = 1
        ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.orDie,
    ),
    finishDelete: (chatId: ChatId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM chat_messages WHERE chat_id = ${chatId}`;
            yield* sql`DELETE FROM chat_sessions WHERE chat_id = ${chatId}`;
            yield* sql`DELETE FROM chat_inputs WHERE chat_id = ${chatId}`;
            yield* sql`DELETE FROM chat_questions WHERE chat_id = ${chatId}`;
            yield* sql`UPDATE chats SET cleanup_pending = 0, boot_id = NULL, status = NULL
              WHERE id = ${chatId}`;
          }),
        )
        .pipe(Effect.orDie),

    input: (chatId: ChatId, inputId: InputId) =>
      sql`SELECT ${inputColumns} FROM chat_inputs
        WHERE chat_id = ${chatId} AND input_id = ${inputId}`.pipe(
        Effect.orDie,
        Effect.flatMap(inputsOf),
        Effect.map(([input]) => input ?? null),
      ),
    latestInput: (chatId: ChatId) =>
      sql`SELECT ${inputColumns} FROM chat_inputs
        WHERE chat_id = ${chatId} ORDER BY ordinal DESC LIMIT 1`.pipe(
        Effect.orDie,
        Effect.flatMap(inputsOf),
        Effect.map(([input]) => input ?? null),
      ),
    addInput: (
      chatId: ChatId,
      input: {
        readonly inputId: InputId;
        readonly payload: InputPayload;
        readonly at: string;
      },
    ) =>
      sql`INSERT INTO chat_inputs (chat_id, input_id, ordinal, state, payload_json, created_at)
        SELECT ${chatId}, ${input.inputId},
          COALESCE((SELECT MAX(ordinal) + 1 FROM chat_inputs WHERE chat_id = ${chatId}), 0),
          'waiting', ${encodePayload(input.payload)}, ${input.at}
        ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.orDie),
    openInputs: (chatId: ChatId) =>
      sql`SELECT ${inputColumns} FROM chat_inputs
        WHERE chat_id = ${chatId} AND state IN ('waiting', 'admitted') ORDER BY ordinal`.pipe(
        Effect.orDie,
        Effect.flatMap(inputsOf),
      ),
    hasOpenInputs: (chatId: ChatId) =>
      sql<{ readonly one: number }>`SELECT 1 AS one FROM chat_inputs
        WHERE chat_id = ${chatId} AND state IN ('waiting', 'admitted') LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    moveInput: (
      chatId: ChatId,
      inputId: InputId,
      from: ReadonlyArray<InputState>,
      to: InputState,
    ) =>
      sql<{ readonly inputId: string }>`UPDATE chat_inputs SET state = ${to}
        WHERE chat_id = ${chatId} AND input_id = ${inputId} AND ${sql.in("state", from)}
        RETURNING input_id AS "inputId"`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    cancelInputs: (chatId: ChatId, through: number, states: ReadonlyArray<InputState>) =>
      sql<{ readonly inputId: string }>`UPDATE chat_inputs SET state = 'cancelled'
        WHERE chat_id = ${chatId} AND ordinal <= ${through} AND ${sql.in("state", states)}
        RETURNING input_id AS "inputId"`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    sessions: (chatId: ChatId) =>
      sql`SELECT ${sessionColumns} FROM chat_sessions WHERE chat_id = ${chatId} ORDER BY rowid`.pipe(
        Effect.flatMap(decodeSessions),
        Effect.orDie,
      ),
    putSession: (chatId: ChatId, session: Omit<SessionRow, "tailCursor">) =>
      sql<{ readonly sessionId: string }>`INSERT INTO chat_sessions (chat_id, session_id,
          parent_session_id, info_json)
        VALUES (${chatId}, ${session.sessionId}, ${session.parentSessionId}, ${encodeSessionInfo(session.info)})
        ON CONFLICT (chat_id, session_id) DO UPDATE SET info_json = excluded.info_json
          WHERE chat_sessions.info_json IS NOT excluded.info_json
        RETURNING session_id AS "sessionId"`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    resetTails: (chatId: ChatId) =>
      sql`UPDATE chat_sessions SET tail_cursor = NULL WHERE chat_id = ${chatId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    capture: (
      chatId: ChatId,
      sessionId: string,
      messages: ReadonlyArray<SessionMessage.Info>,
      tailCursor?: string,
    ) => sql.withTransaction(captureIn(chatId, sessionId, messages, tailCursor)).pipe(Effect.orDie),
    liveMessageIds: (chatId: ChatId, sessionId: string) =>
      sql<{ readonly id: string }>`SELECT message_id AS id FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'live'
        ORDER BY ordinal`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),
    hasLive: (chatId: ChatId) =>
      sql<{ readonly one: number }>`SELECT 1 AS one FROM chat_messages
        WHERE chat_id = ${chatId} AND state = 'live' LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    loseSession: (chatId: ChatId, sessionId: string) =>
      sql<{ readonly messageId: string }>`UPDATE chat_messages SET state = 'lost'
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'live'
        RETURNING message_id AS "messageId"`.pipe(
        Effect.map((rows) => rows.map((row) => row.messageId)),
        Effect.orDie,
      ),
    loseVm: (
      chatId: ChatId,
      noteOf: (gone: {
        readonly lost: ReadonlyArray<LostMessage>;
        readonly questions: ReadonlyArray<Form.Info>;
      }) => Effect.Effect<SessionMessage.Info | null>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<MessageRow>`UPDATE chat_messages SET state = 'lost'
              WHERE chat_id = ${chatId} AND state = 'live' RETURNING ${messageColumns}`;
            const lost = yield* Effect.forEach(
              rows.toSorted((left, right) => left.ordinal - right.ordinal),
              (row) =>
                decodeMessage(row.json).pipe(
                  Effect.map((message) => ({ sessionId: row.sessionId, message })),
                ),
            );
            const questions = (yield* sql`DELETE FROM chat_questions WHERE chat_id = ${chatId}
              RETURNING ${questionColumns}`.pipe(Effect.flatMap(decodeQuestions))).map(
              (question) => question.form,
            );
            const note = yield* noteOf({ lost, questions });
            if (note !== null) yield* captureIn(chatId, rootSessionId(chatId), [note], undefined);
            return { lost, questions, note };
          }),
        )
        .pipe(Effect.orDie),
    message: (chatId: ChatId, sessionId: string, messageId: string) =>
      sql<MessageRow>`SELECT ${messageColumns} FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND message_id = ${messageId}`.pipe(
        Effect.map(([row]) => row ?? null),
        Effect.orDie,
      ),
    messages: (chatId: ChatId, sessionId: string, messageIds: ReadonlyArray<string>) =>
      messageIds.length === 0
        ? Effect.succeed([])
        : sql<MessageRow>`SELECT ${messageColumns} FROM chat_messages
            WHERE chat_id = ${chatId} AND session_id = ${sessionId}
              AND ${sql.in("message_id", messageIds)}
            ORDER BY ordinal`.pipe(Effect.orDie),
    page: (chatId: ChatId, sessionId: string, beforeOrdinal: number | null, limit: number) =>
      sql<MessageRow>`SELECT ${messageColumns}
        FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId}
          AND ordinal < ${beforeOrdinal ?? Number.MAX_SAFE_INTEGER}
        ORDER BY ordinal DESC LIMIT ${limit + 1}`.pipe(
        Effect.map((rows) => ({ rows: rows.slice(0, limit), earlier: rows.length > limit })),
        Effect.orDie,
      ),
    settled: (chatId: ChatId, sessionId: string) =>
      Effect.gen(function* () {
        const [count] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM chat_messages
          WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'settled'`;
        // A long chat starts at its latest completed compaction, which gives the model the same
        // context in fewer messages than one import can take.
        const [cut] =
          (count?.count ?? 0) > IMPORT_CUT_MESSAGES
            ? yield* sql<{ readonly ordinal: number }>`SELECT ordinal FROM chat_messages
                WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'settled'
                  AND type = 'compaction' AND json_extract(json, '$.status') = 'completed'
                ORDER BY ordinal DESC LIMIT 1`
            : [];
        const rows = yield* sql<MessageRow>`SELECT ${messageColumns} FROM chat_messages
          WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'settled'
            AND ordinal >= ${cut?.ordinal ?? 0}
          ORDER BY ordinal`;
        return yield* Effect.forEach(rows, (row) => decodeMessage(row.json));
      }).pipe(Effect.orDie),
    lastTurnLost: (chatId: ChatId, sessionId: string) =>
      sql<{ readonly state: string }>`SELECT state FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND type IN ('user', 'assistant')
        ORDER BY ordinal DESC LIMIT 1`.pipe(
        Effect.map(([row]) => row?.state === "lost"),
        Effect.orDie,
      ),
    latestTurn: (chatId: ChatId, sessionId: string) =>
      sql<MessageRow>`SELECT ${messageColumns} FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} AND state = 'settled'
          AND type IN ('user', 'assistant')
        ORDER BY ordinal DESC LIMIT 1`.pipe(
        Effect.orDie,
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.succeed(null) : decodeMessage(row.json),
        ),
      ),

    questions: (chatId: ChatId) =>
      sql`SELECT ${questionColumns}
        FROM chat_questions WHERE chat_id = ${chatId} ORDER BY asked_at, form_id`.pipe(
        Effect.flatMap(decodeQuestions),
        Effect.orDie,
      ),
    setQuestions: (chatId: ChatId, forms: ReadonlyArray<Form.Info>, at: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* sql<{ readonly key: string }>`SELECT
                session_id || ' ' || form_id AS key FROM chat_questions WHERE chat_id = ${chatId}`;
            const keep = new Set(forms.map((form) => `${form.sessionID} ${form.id}`));
            const gone = current.filter((row) => !keep.has(row.key));
            for (const row of gone) {
              yield* sql`DELETE FROM chat_questions
                WHERE chat_id = ${chatId} AND session_id || ' ' || form_id = ${row.key}`;
            }
            const known = new Set(current.map((row) => row.key));
            const added = forms.filter((form) => !known.has(`${form.sessionID} ${form.id}`));
            for (const form of added) {
              yield* sql`INSERT INTO chat_questions (chat_id, session_id, form_id, form_json, asked_at)
                VALUES (${chatId}, ${form.sessionID}, ${form.id}, ${encodeForm(form)}, ${at})
                ON CONFLICT DO NOTHING`;
            }
            return gone.length > 0 || added.length > 0;
          }),
        )
        .pipe(Effect.orDie),

    readWorkspace: (chatId: ChatId) =>
      fileSystem.readFile(workspaceFile(chatId)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
        Effect.orDie,
      ),
    saveWorkspace: (chatId: ChatId, content: Uint8Array) =>
      Effect.gen(function* () {
        const target = workspaceFile(chatId);
        yield* fileSystem.makeDirectory(workspacesDir, { recursive: true });
        // Written beside it first, so a save cut short leaves the last good one.
        yield* fileSystem.writeFile(`${target}.part`, content);
        yield* fileSystem.rename(`${target}.part`, target);
        yield* sql`UPDATE chats SET workspace_unsaved = 0 WHERE id = ${chatId}`;
      }).pipe(Effect.orDie),
    markWorkspaceUnsaved: (chatId: ChatId) =>
      sql<{ readonly id: string }>`UPDATE chats SET workspace_unsaved = 1
        WHERE id = ${chatId} AND workspace_unsaved = 0
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    deleteWorkspace: (chatId: ChatId) =>
      Effect.gen(function* () {
        const target = workspaceFile(chatId);
        yield* fileSystem.remove(target, { force: true });
        yield* fileSystem.remove(`${target}.part`, { force: true });
      }).pipe(Effect.orDie),
  };
});

export class ChatRepository extends Context.Service<ChatRepository, Effect.Success<typeof make>>()(
  "t45/chats/ChatRepository",
) {}

export const layer = Layer.effect(ChatRepository, make);
