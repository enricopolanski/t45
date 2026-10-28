import { Comment, Ticket } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM tickets t WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
  const first = Effect.map(([ticket]: ReadonlyArray<Ticket>) => ticket ?? null);

  return {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die })),
    get: (id: string) => read("t.id = ?", [id]).pipe(first),
    getByStepId: (stepId: string) =>
      read(`EXISTS (SELECT 1 FROM json_each(t.steps) s WHERE json_extract(s.value, '$.id') = ?)`, [
        stepId,
      ]).pipe(first),
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
      }).pipe(Effect.orDie),
    update: (ticket: Ticket) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(ticket);
        yield* sql`UPDATE tickets SET title = ${row.title}, description = ${row.description},
              due_date = ${row.dueDate}, status = ${row.status}, steps = ${row.steps}
            WHERE id = ${row.id}`;
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
      }).pipe(Effect.orDie),
  };
});

export class TicketRepository extends Context.Service<
  TicketRepository,
  Effect.Success<typeof make>
>()("t45/workflows/TicketRepository") {}
export const layer = Layer.effect(TicketRepository, make);
