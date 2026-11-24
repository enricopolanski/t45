import { StepResultVersion, StepResultSnapshot } from "@t45/contracts/models/StepResultHistory";
import * as DateTime from "effect/DateTime";
import { Comment, Ticket } from "@t45/contracts/models/Workflow";
import type { AttachmentId } from "@t45/contracts/models/Attachment";
import { StepSnapshot } from "@t45/contracts/resources/Workflows";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Ticket.fields,
  status: Schema.fromJsonString(Ticket.fields.status),
  steps: Schema.fromJsonString(Ticket.fields.steps),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(Comment));
const encodeComment = Schema.encodeEffect(Comment);
const SnapshotJson = Schema.fromJsonString(StepSnapshot);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);
const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson);

const StepResultSnapshotJson = Schema.fromJsonString(StepResultSnapshot);
const encodeStepResultSnapshot = Schema.encodeEffect(StepResultSnapshotJson);
const encodeStepResultInputs = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
);
const decodeStepResultHistory = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...StepResultVersion.fields,
      snapshot: StepResultSnapshotJson,
    }),
  ),
);

const COLUMNS = `t.id, t.project_id AS "projectId", t.workflow_version_id AS "workflowVersionId",
  t.title, t.description, t.status, t.creator_user_id AS "creatorUserId", t.steps,
  t.created_at AS "createdAt"`;

const IS_OPEN = `json_extract(t.status, '$.type') = 'open'`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const watchers = new Set<{
    readonly ticket: Pick<Ticket, "id" | "projectId">;
    readonly queue: Queue.Queue<void>;
  }>();
  // Each matching view needs at most one pending reread, regardless of the number of writes.
  const publishChange = (id?: string) =>
    sql.afterCommit(
      Effect.sync(() => {
        for (const { ticket, queue } of watchers) {
          if (id === undefined || id === ticket.id || id === ticket.projectId)
            Queue.offerUnsafe(queue, undefined);
        }
      }),
    );
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM tickets t WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
  const first = Effect.map(([ticket]: ReadonlyArray<Ticket>) => ticket ?? null);

  return {
    publishChange,
    watch: <A, E, R>(
      ticket: Pick<Ticket, "id" | "projectId">,
      read: Effect.Effect<A, E, R>,
      observe?: (notify: () => void) => Effect.Effect<void, never, Scope>,
    ) =>
      Stream.unwrap(
        Effect.acquireRelease(
          Queue.dropping<void>(1).pipe(
            Effect.map((queue) => {
              const watcher = { ticket, queue };
              watchers.add(watcher);
              return watcher;
            }),
          ),
          (watcher) =>
            Effect.sync(() => {
              watchers.delete(watcher);
              Queue.shutdownUnsafe(watcher.queue);
            }),
        ).pipe(
          Effect.tap(
            ({ queue }) =>
              observe?.(() => {
                Queue.offerUnsafe(queue, undefined);
              }) ?? Effect.void,
          ),
          Effect.map(({ queue }) =>
            Stream.concat(
              Stream.fromEffect(read),
              Stream.fromQueue(queue).pipe(Stream.mapEffect(() => read)),
            ),
          ),
        ),
      ),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die })),
    get: (id: string) => read("t.id = ?", [id]).pipe(first),
    getByStepId: (stepId: string) =>
      read(`EXISTS (SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.id') = ?)`, [
        stepId,
      ]).pipe(first),
    /** The project's tickets whose title holds `query`, newest first. */
    listForProject: (projectId: string, query: string) =>
      read(
        `t.project_id = ? AND instr(lower(t.title), lower(?)) > 0
          ORDER BY t.created_at DESC, t.id DESC`,
        [projectId, query.trim()],
      ),
    listOpen: (projectId: string) =>
      read(`t.project_id = ? AND ${IS_OPEN} ORDER BY t.created_at, t.id`, [projectId]),
    listOpenInvolving: (id: string) =>
      read(
        `${IS_OPEN} AND EXISTS (SELECT 1 FROM json_each(t.steps) s
            WHERE json_extract(s.value, '$.assignee') = ?)
          ORDER BY t.created_at, t.id`,
        [id],
      ),
    insert: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`INSERT INTO tickets (id, project_id, workflow_version_id, title, description,
              status, creator_user_id, steps, created_at)
            VALUES (${row.id}, ${row.projectId}, ${row.workflowVersionId}, ${row.title},
              ${row.description}, ${row.status}, ${row.creatorUserId}, ${row.steps}, ${row.createdAt})`;
        yield* publishChange(ticket.id);
      }).pipe(Effect.orDie),
    update: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`UPDATE tickets SET title = ${row.title}, description = ${row.description},
              status = ${row.status}, steps = ${row.steps}
            WHERE id = ${row.id}`;
        yield* publishChange(ticket.id);
      }).pipe(Effect.orDie),
    comments: (stepId: string) =>
      sql`SELECT id, author_id AS "author", body, created_at AS "createdAt",
            step_id AS "stepId"
          FROM workflow_comments WHERE step_id = ${stepId} ORDER BY created_at, rowid`.pipe(
        Effect.flatMap(decodeComments),
        Effect.orDie,
      ),
    /**
     * How many tickets hold the record's key in a list of their steps' values, on a version with a
     * records field of its collection. Completed steps keep their own copy of the records.
     */
    countLinking: (collectionId: string, key: string) =>
      sql<{ readonly count: number }>`SELECT count(*) AS count FROM tickets t
          JOIN workflow_versions v ON v.id = t.workflow_version_id
        WHERE EXISTS (SELECT 1 FROM json_tree(v.steps) field WHERE field.type = 'object'
            AND json_extract(field.value, '$.type') = 'records'
            AND json_extract(field.value, '$.collectionId') = ${collectionId})
          AND EXISTS (SELECT 1 FROM json_tree(t.steps) item WHERE item.atom = ${key}
            AND typeof(item.key) = 'integer' AND item.path LIKE '$[%].values%')`.pipe(
        Effect.map(([row]) => row!.count),
        Effect.orDie,
      ),
    insertComment: (ticketId: string, comment: Comment) =>
      Effect.gen(function* () {
        const row = yield* encodeComment(comment);
        yield* sql`INSERT INTO workflow_comments (id, ticket_id, step_id, author_id, body,
              created_at)
            VALUES (${row.id}, ${ticketId}, ${row.stepId}, ${row.author}, ${row.body},
              ${row.createdAt})`;
        yield* publishChange(ticketId);
      }).pipe(Effect.orDie),
    resultHistory: {
      // Only the newest snapshot participates in deduplication: A → B → A is three calculations.
      append: (
        ticketId: string,
        stepDefinitionId: string,
        items: ReadonlyArray<{ key: string; snapshot: StepResultSnapshot }>,
      ) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          for (const { key, snapshot } of items) {
            const encoded = yield* encodeStepResultSnapshot(snapshot);
            yield* sql`WITH last AS (
              SELECT snapshot FROM step_result_versions WHERE ticket_id = ${ticketId}
                AND step_definition_id = ${stepDefinitionId} AND result_key = ${key} ORDER BY id DESC LIMIT 1
            ) INSERT INTO step_result_versions(ticket_id, step_definition_id, result_key, recorded_at, snapshot)
              SELECT ${ticketId}, ${stepDefinitionId}, ${key}, ${at}, ${encoded}
              WHERE (${snapshot.sources.length + snapshot.results.length} > 0 OR EXISTS (SELECT 1 FROM last))
                AND (SELECT snapshot FROM last) IS NOT ${encoded}`;
          }
        }).pipe(Effect.orDie),
      list: (ticketId: string, stepDefinitionId: string, key: string, limit = -1) =>
        sql`SELECT id, recorded_at AS recordedAt, snapshot
          FROM step_result_versions WHERE ticket_id = ${ticketId} AND step_definition_id = ${stepDefinitionId}
            AND result_key = ${key} ORDER BY id DESC LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeStepResultHistory),
          Effect.orDie,
        ),
      hasInputs: (ticketId: string) =>
        sql`SELECT 1 FROM step_result_inputs WHERE ticket_id = ${ticketId} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      latestIds: (ticketId: string, stepDefinitionId: string) =>
        sql<{ resultKey: string; id: number }>`SELECT result_key AS resultKey, MAX(id) AS id
          FROM step_result_versions WHERE ticket_id = ${ticketId} AND step_definition_id = ${stepDefinitionId}
          GROUP BY result_key`.pipe(
          Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.resultKey, row.id]))),
          Effect.orDie,
        ),
      setInputs: (ticketId: string, inputs: ReadonlyMap<string, Set<string>>) =>
        Effect.gen(function* () {
          const keys = yield* encodeStepResultInputs(
            [...inputs].flatMap(([collection, records]) =>
              [...records].map((key) => [collection, key] as const),
            ),
          );
          yield* sql`DELETE FROM step_result_inputs WHERE ticket_id = ${ticketId}
            AND (collection_id, record_key) NOT IN
              (SELECT value ->> 0, value ->> 1 FROM json_each(${keys}))`;
          yield* sql`INSERT OR IGNORE INTO step_result_inputs (collection_id, record_key, ticket_id)
            SELECT value ->> 0, value ->> 1, ${ticketId} FROM json_each(${keys})`;
        }).pipe(Effect.orDie),
      forRecord: (collectionId: string, key: string) =>
        sql<{ id: string }>`SELECT ticket_id AS id FROM step_result_inputs
          WHERE collection_id = ${collectionId} AND record_key = ${key}`.pipe(Effect.orDie),
    },
    completedSteps: {
      has: (stepId: string) =>
        sql`SELECT 1 FROM completed_steps WHERE step_id = ${stepId}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      get: (stepId: string) =>
        sql<{ readonly snapshot: string }>`SELECT snapshot FROM completed_steps
          WHERE step_id = ${stepId}`.pipe(
          Effect.flatMap(([row]) =>
            row === undefined ? Effect.succeed(null) : decodeSnapshot(row.snapshot),
          ),
          Effect.orDie,
        ),
      save: (
        ticketId: string,
        stepId: string,
        snapshot: StepSnapshot,
        attachmentIds: ReadonlyArray<AttachmentId>,
      ) =>
        Effect.gen(function* () {
          const encoded = yield* encodeSnapshot(snapshot);
          yield* sql`INSERT INTO completed_steps (step_id, ticket_id, snapshot)
            VALUES (${stepId}, ${ticketId}, ${encoded})`;
          if (attachmentIds.length > 0)
            yield* sql`INSERT INTO completed_step_files (step_id, attachment_id)
              SELECT ${stepId}, id FROM attachments WHERE ${sql.in("id", attachmentIds)}`;
        }).pipe(Effect.orDie),
      holdingFile: (attachmentId: AttachmentId) =>
        sql<{ readonly stepId: string; readonly ticketId: string }>`
          SELECT c.step_id AS "stepId", c.ticket_id AS "ticketId"
          FROM completed_step_files cf JOIN completed_steps c ON c.step_id = cf.step_id
          WHERE cf.attachment_id = ${attachmentId}`.pipe(Effect.orDie),
    },
  };
});

export class TicketRepository extends Context.Service<
  TicketRepository,
  Effect.Success<typeof make>
>()("t45/workflows/TicketRepository") {}
export const layer = Layer.effect(TicketRepository, make);
