import {
  Comment,
  Ticket,
  oversees,
  type Project,
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

const COLUMNS = `t.id, t.project_id AS "projectId", t.title, t.description, t.due_date AS "dueDate",
  t.status, t.steps, t.created_at AS "createdAt"`;

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
    watch: <A, E, R>(ticket: Pick<Ticket, "id" | "projectId">, read: Effect.Effect<A, E, R>) =>
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
    listForProject: (project: Project, actor: WorkflowActor, query: string) => {
      const visible = sql`t.project_id = ${project.id}
        AND instr(lower(t.title), lower(${query.trim()})) > 0
        AND (${project.isPublic || oversees(actor, project)} OR EXISTS (
          SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.assignee') = ${actor.id}))`;
      return Effect.gen(function* () {
        const rows = yield* sql`SELECT ${sql.literal(COLUMNS)} FROM tickets t WHERE ${visible}
          ORDER BY t.created_at DESC, t.id DESC LIMIT 100`;
        const [count] = yield* sql<{
          readonly total: number;
        }>`SELECT count(*) AS total FROM tickets t WHERE ${visible}`;
        return { tickets: yield* decodeRows(rows), total: count!.total };
      }).pipe(Effect.orDie);
    },
    hasTicketsInvolving: (projectId: string, userId: string) =>
      sql`SELECT 1 FROM tickets t WHERE t.project_id = ${projectId} AND EXISTS (
        SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.assignee') = ${userId})
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    projectIdsInvolving: (userId: string) =>
      sql<{ readonly id: string }>`SELECT DISTINCT t.project_id AS id FROM tickets t
        WHERE EXISTS (SELECT 1 FROM json_each(t.steps) s
          WHERE json_extract(s.value, '$.assignee') = ${userId})`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
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
    hasTickets: (projectId: string) =>
      sql`SELECT 1 FROM tickets WHERE project_id = ${projectId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    insert: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`INSERT INTO tickets (id, project_id, title, description, due_date, status,
              steps, created_at)
            VALUES (${row.id}, ${row.projectId}, ${row.title}, ${row.description},
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
