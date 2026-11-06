/**
 * What T45 stores for its chats: the chats, the inputs sent to them, the OpenCode sessions and
 * messages their executions wrote, and the VM disk the last finished one left, a file in the
 * server's state folder. The questions a running execution's VM is waiting on are kept in memory,
 * since they go with the VM.
 */
import { Form } from "@opencode/schema/form";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type * as Statement from "effect/sql/Statement";
import { ChatOrigin, Task, TaskState, Trigger } from "@t45/contracts/models/Task";
import { WorkflowInstanceResponse } from "@t45/contracts/resources/AgentTools";
import { ChatSummary } from "@t45/contracts/resources/Chats";
import type { Agent } from "@t45/contracts/models/Agent";
import {
  Chat,
  type ChatId,
  ChatStatus,
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
const decodeTaskRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      task: Schema.fromJsonString(Task),
      chatStatus: Schema.NullOr(Schema.Union([ChatStatus, Schema.Literal("deleted")])),
    }),
  ),
);

const decodeOperation = Schema.decodeEffect(Schema.fromJsonString(WorkflowInstanceResponse));
const encodeOperation = Schema.encodeSync(Schema.fromJsonString(WorkflowInstanceResponse));

const makeOrigins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = (where: Statement.Fragment) =>
    sql<{ readonly origin: string }>`SELECT json_object('chatId', chat_id,
      'kind', CASE WHEN owner_user_id IS NULL THEN 'task' ELSE 'conversation' END,
      'ownerUserId', owner_user_id, 'workflowId', workflow_id, 'trigger', json(trigger), 'state', json(state)) AS origin
      FROM chat_origins WHERE ${where}`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeOrigin(row.origin))),
      Effect.orDie,
    );
  const get = (chatId: ChatId) =>
    select(sql`chat_id = ${chatId}`).pipe(Effect.map((rows) => rows[0] ?? null));
  return {
    get,
    insert: (origin: ChatOrigin) =>
      sql`INSERT INTO chat_origins (chat_id, owner_user_id, workflow_id, trigger, state)
      VALUES (${origin.chatId}, ${origin.kind === "conversation" ? origin.ownerUserId : null},
        ${origin.kind === "conversation" ? origin.workflowId : null},
        ${origin.kind === "task" ? encodeTrigger(origin.trigger) : null},
        ${origin.kind === "task" ? encodeState(origin.state) : null})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    setState: (chatId: ChatId, state: TaskState) =>
      sql`UPDATE chat_origins SET state = ${encodeState(state)}
      WHERE chat_id = ${chatId} AND trigger IS NOT NULL`.pipe(Effect.asVoid, Effect.orDie),
    listByTrigger: (reference: { readonly ticketId: string; readonly stepId: string }) =>
      sql`SELECT json_object('kind', 'task', 'chatId', o.chat_id,
          'trigger', json(o.trigger), 'state', json(o.state)) AS task,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'deleted' ELSE c.status END AS "chatStatus"
        FROM chat_origins o JOIN chats c ON c.id = o.chat_id
        WHERE o.trigger IS NOT NULL
          AND json_extract(o.trigger, '$.ticketId') = ${reference.ticketId}
          AND json_extract(o.trigger, '$.stepId') = ${reference.stepId}
        ORDER BY c.created_at, c.id`.pipe(
        Effect.flatMap(decodeTaskRows),
        Effect.map((rows) => rows.map(({ task, chatStatus }) => ({ ...task, chatStatus }))),
        Effect.orDie,
      ),
    operationReceipt: (chatId: ChatId, requestId: string) =>
      sql<{
        readonly response: string;
      }>`SELECT response FROM workflow_operation_receipts WHERE chat_id = ${chatId} AND request_id = ${requestId}`.pipe(
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.succeed(null) : decodeOperation(row.response),
        ),
        Effect.orDie,
      ),
    recordOperation: (chatId: ChatId, response: typeof WorkflowInstanceResponse.Type) =>
      sql`INSERT INTO workflow_operation_receipts (chat_id, request_id, response) VALUES (${chatId}, ${response.call.input.requestId}, ${encodeOperation(response)})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    recordedCalls: (chatId: ChatId, keys: ReadonlyArray<string>) =>
      sql<{ readonly key: string }>`SELECT call_key AS key FROM task_calls
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
const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(ChatSummary));

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

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(SessionMessage.Info));

/** Where chats' disks are kept, under the server's state folder. */
const DISKS_DIRECTORY = "chat-disks";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* ServerConfig.stateDir;
  const disksDir = path.join(stateDir, DISKS_DIRECTORY);
  const diskFile = (chatId: ChatId) => path.join(disksDir, `${chatId}.tgz`);

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
  /** The chat's inputs whose user message isn't stored: what its next execution sends. */
  const pendingInputs = (chatId: ChatId) =>
    sql`SELECT ${inputColumns} FROM chat_inputs AS input
      WHERE input.chat_id = ${chatId} AND NOT EXISTS (
        SELECT 1 FROM chat_messages AS message
        WHERE message.chat_id = input.chat_id
          AND message.session_id = ${rootSessionId(chatId)}
          AND message.message_id = ${inputMessageId(chatId, "")} || input.input_id
      ) ORDER BY input.ordinal`.pipe(Effect.orDie, Effect.flatMap(inputsOf));

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
      sql`SELECT c.id, c.agent_id AS "agentId", c.title, c.status, c.updated_at AS "lastActivityAt",
          a.name AS "agentName", o.workflow_id AS "workflowId", w.name AS "workflowName"
        FROM chats c JOIN chat_origins o ON o.chat_id = c.id
          LEFT JOIN agents a ON a.id = c.agent_id LEFT JOIN workflows w ON w.id = o.workflow_id
        WHERE c.deleted_at IS NULL AND o.owner_user_id = ${member.userId}
        ORDER BY c.updated_at DESC, c.id DESC`.pipe(Effect.flatMap(decodeSummaries), Effect.orDie),
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
    setStatus: (chatId: ChatId, status: Exclude<ChatStatus, "running"> | null, at: string | null) =>
      sql<{ readonly id: string }>`UPDATE chats SET status = ${status},
          updated_at = COALESCE(${at}, updated_at)
        WHERE id = ${chatId} AND status = 'running'
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
    /** Keeps what a finished execution wrote, as its saved disk has it. */
    commit: (chatId: ChatId) =>
      Effect.gen(function* () {
        yield* sql`UPDATE chat_messages SET committed = 1 WHERE chat_id = ${chatId}`;
        yield* sql`UPDATE chat_sessions SET committed = 1 WHERE chat_id = ${chatId}`;
      }).pipe(Effect.orDie),
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
      sql<MessageRow>`SELECT ${messageColumns} FROM chat_messages
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

    readDisk: (chatId: ChatId) =>
      fileSystem.readFile(diskFile(chatId)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
        Effect.orDie,
      ),
    saveDisk: (chatId: ChatId, content: Uint8Array) =>
      Effect.gen(function* () {
        const target = diskFile(chatId);
        yield* fileSystem.makeDirectory(disksDir, { recursive: true });
        // Written beside it first, so a save cut short leaves the last good one.
        yield* fileSystem.writeFile(`${target}.part`, content);
        yield* fileSystem.rename(`${target}.part`, target);
      }).pipe(Effect.orDie),
    deleteDisk: (chatId: ChatId) =>
      Effect.gen(function* () {
        const target = diskFile(chatId);
        yield* fileSystem.remove(target, { force: true });
        yield* fileSystem.remove(`${target}.part`, { force: true });
      }).pipe(Effect.orDie),
  };
});

export class ChatRepository extends Context.Service<ChatRepository, Effect.Success<typeof make>>()(
  "t45/chats/ChatRepository",
) {}

export const layer = Layer.effect(ChatRepository, make);
