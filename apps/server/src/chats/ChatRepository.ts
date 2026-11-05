/**
 * What T45 stores for its chats: the chats, the inputs sent to them, the OpenCode sessions and
 * messages their executions wrote, and the agent's saved workspace, whose tarball is a file in the
 * server's state folder. The questions a running execution's VM is waiting on are kept in memory,
 * since they go with the VM.
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
} from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import type { Member } from "./ChatService.ts";
import { inputMessageId, isInputMessage, rootSessionId } from "./ChatIds.ts";

const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  parentSessionId: Schema.NullOr(Schema.String),
  info: Schema.fromJsonString(Session.Info),
});
type SessionRow = typeof SessionRow.Type;

export interface MessageRow {
  readonly sessionId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly json: string;
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

const MESSAGE_COLUMNS = `session_id AS "sessionId", message_id AS "messageId", ordinal, json`;

const SESSION_COLUMNS = `session_id AS "sessionId", parent_session_id AS "parentSessionId",
  info_json AS "info"`;

const INPUT_COLUMNS = `input_id AS "inputId", ordinal, payload_json AS "payload",
  created_at AS "createdAt"`;

const decodeInputs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...Input.fields, payload: Schema.fromJsonString(InputPayload) })),
);

const inputsOf = (rows: ReadonlyArray<unknown>) => decodeInputs(rows).pipe(Effect.orDie);
const encodePayload = Schema.encodeSync(Schema.fromJsonString(InputPayload));

const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow));
const encodeSessionInfo = Schema.encodeSync(Schema.fromJsonString(Session.Info));

const MessageJson = Schema.fromJsonString(SessionMessage.Info);
const encodeMessage = Schema.encodeSync(MessageJson);
const decodeMessage = Schema.decodeEffect(MessageJson);

/**
 * Whether OpenCode finished writing the message, by its own rule: an assistant once completed, a
 * shell or compaction once it stopped running, anything else once it exists.
 */
export const isSettled = (message: SessionMessage.Info) => {
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
  /** The forms each running execution's VM lists, by chat. */
  const questions = new Map<ChatId, ReadonlyArray<Form.Info>>();
  const formKeys = (forms: ReadonlyArray<Form.Info>) =>
    forms
      .map((form) => `${form.sessionID} ${form.id}`)
      .toSorted()
      .join("\n");
  const sessionColumns = sql.literal(SESSION_COLUMNS);
  const inputs = (chatId: ChatId) =>
    sql`SELECT ${inputColumns} FROM chat_inputs WHERE chat_id = ${chatId} ORDER BY ordinal`.pipe(
      Effect.orDie,
      Effect.flatMap(inputsOf),
    );
  /** The chat's inputs whose user message isn't stored: what its next execution sends. */
  const pendingInputs = (chatId: ChatId) =>
    Effect.gen(function* () {
      const all = yield* inputs(chatId);
      if (all.length === 0) return all;
      const ids = all.map((input) => inputMessageId(chatId, input.inputId));
      const stored = new Set(
        (yield* sql<{ readonly id: string }>`SELECT message_id AS id FROM chat_messages
          WHERE chat_id = ${chatId} AND session_id = ${rootSessionId(chatId)}
            AND ${sql.in("message_id", ids)}`.pipe(Effect.orDie)).map((row) => row.id),
      );
      return all.filter((input) => !stored.has(inputMessageId(chatId, input.inputId)));
    });

  const get = (chatId: ChatId) =>
    sql`SELECT ${chatColumns} FROM chats WHERE id = ${chatId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeChat(row))),
      Effect.orDie,
    );

  return {
    get,
    origins,
    insert: (row: {
      readonly id: ChatId;
      readonly agentId: Agent["id"];
      readonly title: string | null;
      readonly at: string;
    }) =>
      sql`INSERT INTO chats (id, agent_id, title, created_at, updated_at)
        VALUES (${row.id}, ${row.agentId}, ${row.title},
          ${row.at}, ${row.at})`.pipe(Effect.asVoid, Effect.orDie),
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
    /** An input owes the chat an execution. */
    markRunning: (chatId: ChatId, at: string) =>
      sql`UPDATE chats SET status = 'running', updated_at = ${at}
        WHERE id = ${chatId}`.pipe(Effect.asVoid, Effect.orDie),
    /**
     * Moves a chat whose execution is owed to `status`, and its latest activity to `at` when
     * given; false when nothing changed, as for a chat a stop already ended.
     */
    setStatus: (chatId: ChatId, status: ChatStatus | null, at: string | null) =>
      sql<{ readonly id: string }>`UPDATE chats SET status = ${status},
          updated_at = COALESCE(${at}, updated_at)
        WHERE id = ${chatId} AND status = 'running'
          AND (status IS NOT ${status} OR ${at} IS NOT NULL)
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    /** The chats whose execution is owed, which a server start runs again. */
    owed: sql<{ readonly id: ChatId }>`SELECT id FROM chats
        WHERE deleted_at IS NULL AND status = 'running' ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.orDie,
    ),
    markDeleted: (chatId: ChatId, at: string) =>
      sql`UPDATE chats SET deleted_at = ${at} WHERE id = ${chatId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    finishDelete: (chatId: ChatId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM chat_messages WHERE chat_id = ${chatId}`;
            yield* sql`DELETE FROM chat_sessions WHERE chat_id = ${chatId}`;
            yield* sql`DELETE FROM chat_inputs WHERE chat_id = ${chatId}`;
            yield* sql`UPDATE chats SET status = NULL WHERE id = ${chatId}`;
            questions.delete(chatId);
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
    addInput: (
      chatId: ChatId,
      input: {
        readonly inputId: InputId;
        readonly payload: InputPayload;
        readonly at: string;
      },
    ) =>
      sql`INSERT INTO chat_inputs (chat_id, input_id, ordinal, payload_json, created_at)
        SELECT ${chatId}, ${input.inputId},
          COALESCE((SELECT MAX(ordinal) + 1 FROM chat_inputs WHERE chat_id = ${chatId}), 0),
          ${encodePayload(input.payload)}, ${input.at}`.pipe(Effect.asVoid, Effect.orDie),
    inputs,
    pendingInputs,
    deleteInput: (chatId: ChatId, inputId: InputId) =>
      sql`DELETE FROM chat_inputs WHERE chat_id = ${chatId} AND input_id = ${inputId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),

    sessions: (chatId: ChatId) =>
      sql`SELECT ${sessionColumns} FROM chat_sessions WHERE chat_id = ${chatId} ORDER BY rowid`.pipe(
        Effect.flatMap(decodeSessions),
        Effect.orDie,
      ),
    /** Keeps a session as OpenCode returned it; true when it is new or changed. */
    putSession: (chatId: ChatId, session: SessionRow) =>
      sql<{ readonly sessionId: string }>`INSERT INTO chat_sessions (chat_id, session_id,
          parent_session_id, info_json)
        VALUES (${chatId}, ${session.sessionId}, ${session.parentSessionId}, ${encodeSessionInfo(session.info)})
        ON CONFLICT (chat_id, session_id) DO UPDATE SET info_json = excluded.info_json
          WHERE chat_sessions.info_json IS NOT excluded.info_json
        RETURNING session_id AS "sessionId"`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    /** Drops what an execution that didn't finish wrote, and the questions it asked. */
    discardUncommitted: (chatId: ChatId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const messages = yield* sql`DELETE FROM chat_messages
              WHERE chat_id = ${chatId} AND committed = 0 RETURNING message_id`;
            const sessions = yield* sql`DELETE FROM chat_sessions
              WHERE chat_id = ${chatId} AND committed = 0 RETURNING session_id`;
            const asked = questions.delete(chatId);
            return messages.length + sessions.length > 0 || asked;
          }),
        )
        .pipe(Effect.orDie),
    /** Keeps what a finished execution wrote, which every later execution imports. */
    commit: (chatId: ChatId) =>
      Effect.gen(function* () {
        yield* sql`UPDATE chat_messages SET committed = 1 WHERE chat_id = ${chatId}`;
        yield* sql`UPDATE chat_sessions SET committed = 1 WHERE chat_id = ${chatId}`;
      }).pipe(Effect.orDie),
    /** A session's messages, in order, as an execution imports them. */
    history: (chatId: ChatId, sessionId: string) =>
      sql<{ readonly json: string }>`SELECT json FROM chat_messages
        WHERE chat_id = ${chatId} AND session_id = ${sessionId} ORDER BY ordinal`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeMessage(row.json))),
        Effect.orDie,
      ),
    /**
     * Writes messages OpenCode returned for a session, each new one after the ones it has;
     * `inputsTaken` when one is an input's user message, which takes it out of the pending ones.
     */
    saveMessages: (
      chatId: ChatId,
      sessionId: string,
      messages: ReadonlyArray<SessionMessage.Info>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const written: Array<string> = [];
            for (const message of messages) {
              const changed = yield* sql<{ readonly id: string }>`INSERT INTO chat_messages
                  (chat_id, session_id, message_id, ordinal, json)
                VALUES (${chatId}, ${sessionId}, ${message.id},
                  (SELECT COALESCE(MAX(ordinal) + 1, 0) FROM chat_messages
                    WHERE chat_id = ${chatId} AND session_id = ${sessionId}),
                  ${encodeMessage(message)})
                ON CONFLICT (chat_id, session_id, message_id) DO UPDATE SET
                  json = excluded.json
                  WHERE chat_messages.json IS NOT excluded.json
                RETURNING message_id AS id`;
              if (changed.length > 0) written.push(message.id);
            }
            const inputsTaken = messages.some(
              (message) =>
                message.type === "user" &&
                written.includes(message.id) &&
                isInputMessage(chatId, message.id),
            );
            return { messageIds: written, inputsTaken };
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

    /** The questions the chat's running VM is waiting on, as OpenCode lists them. */
    questions: (chatId: ChatId) =>
      Effect.sync(() =>
        (questions.get(chatId) ?? []).map((form) => ({
          sessionId: Session.ID.make(form.sessionID),
          form,
        })),
      ),
    /** Keeps the forms the chat's VM lists; whether the questions changed. */
    setQuestions: (chatId: ChatId, forms: ReadonlyArray<Form.Info>) =>
      Effect.sync(() => {
        const changed = formKeys(questions.get(chatId) ?? []) !== formKeys(forms);
        if (forms.length === 0) questions.delete(chatId);
        else questions.set(chatId, forms);
        return changed;
      }),

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
      }).pipe(Effect.orDie),
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
