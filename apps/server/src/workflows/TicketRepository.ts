import {
  Comment,
  Ticket,
  oversees,
  type Workflow,
  type WorkflowActor,
} from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
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

const COLUMNS = `t.id, t.workflow_id AS "workflowId", t.title, t.description, t.due_date AS "dueDate",
  t.status, t.steps, t.created_at AS "createdAt"`;

const IS_OPEN = `json_extract(t.status, '$.type') = 'open'`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const watchers = new Set<{
    readonly ticket: Pick<Ticket, "id" | "workflowId">;
    readonly queue: Queue.Queue<void>;
  }>();
  // Each matching view needs at most one pending reread, regardless of the number of writes.
  const publishChange = (id?: string) =>
    sql.afterCommit(
      Effect.sync(() => {
        for (const { ticket, queue } of watchers) {
          if (id === undefined || id === ticket.id || id === ticket.workflowId)
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
    watch: <A, E, R>(ticket: Pick<Ticket, "id" | "workflowId">, read: Effect.Effect<A, E, R>) =>
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
    listForWorkflow: (workflow: Workflow, actor: WorkflowActor, query: string) => {
      const visible = sql`t.workflow_id = ${workflow.id}
        AND instr(lower(t.title), lower(${query.trim()})) > 0
        AND (${workflow.isPublic || oversees(actor, workflow)} OR EXISTS (
          SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.assignee') = ${actor.id}
            OR json_extract(s.value, '$.responsible') = ${actor.id}))`;
      return Effect.gen(function* () {
        const rows = yield* sql`SELECT ${sql.literal(COLUMNS)} FROM tickets t WHERE ${visible}
          ORDER BY t.created_at DESC, t.id DESC LIMIT 100`;
        const [count] = yield* sql<{
          readonly total: number;
        }>`SELECT count(*) AS total FROM tickets t WHERE ${visible}`;
        return { tickets: yield* decodeRows(rows), total: count!.total };
      }).pipe(Effect.orDie);
    },
    hasTicketsInvolving: (workflowId: string, userId: string) =>
      sql`SELECT 1 FROM tickets t WHERE t.workflow_id = ${workflowId} AND EXISTS (
        SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.assignee') = ${userId}
          OR json_extract(s.value, '$.responsible') = ${userId}) LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    workflowIdsInvolving: (userId: string) =>
      sql<{ readonly id: string }>`SELECT DISTINCT t.workflow_id AS id FROM tickets t
        WHERE EXISTS (SELECT 1 FROM json_each(t.steps) s
          WHERE json_extract(s.value, '$.assignee') = ${userId}
            OR json_extract(s.value, '$.responsible') = ${userId})`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),
    listOpen: (workflowId: string) =>
      read(`t.workflow_id = ? AND ${IS_OPEN} ORDER BY t.created_at, t.id`, [workflowId]),
    listOpenInvolving: (id: string) =>
      read(
        `${IS_OPEN} AND EXISTS (SELECT 1 FROM json_each(t.steps) s
            WHERE json_extract(s.value, '$.assignee') = ?
              OR json_extract(s.value, '$.responsible') = ?)
          ORDER BY t.created_at, t.id`,
        [id, id],
      ),
    hasTickets: (workflowId: string) =>
      sql`SELECT 1 FROM tickets WHERE workflow_id = ${workflowId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    insert: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`INSERT INTO tickets (id, workflow_id, title, description, due_date, status,
              steps, created_at)
            VALUES (${row.id}, ${row.workflowId}, ${row.title}, ${row.description},
              ${row.dueDate}, ${row.status}, ${row.steps}, ${row.createdAt})`;
        yield* publishChange(ticket.id);
      }).pipe(Effect.orDie),
    update: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`UPDATE tickets SET title = ${row.title}, description = ${row.description},
              due_date = ${row.dueDate}, status = ${row.status}, steps = ${row.steps}
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
    insertComment: (ticketId: string, comment: Comment) =>
      Effect.gen(function* () {
        const row = yield* encodeComment(comment);
        yield* sql`INSERT INTO workflow_comments (id, ticket_id, step_id, author_id, body,
              created_at)
            VALUES (${row.id}, ${ticketId}, ${row.stepId}, ${row.author}, ${row.body},
              ${row.createdAt})`;
        yield* publishChange(ticketId);
      }).pipe(Effect.orDie),
  };
});

export class TicketRepository extends Context.Service<
  TicketRepository,
  Effect.Success<typeof make>
>()("t45/workflows/TicketRepository") {}
export const layer = Layer.effect(TicketRepository, make);
