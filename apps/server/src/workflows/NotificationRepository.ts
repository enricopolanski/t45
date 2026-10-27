import { Notification, type NotificationKind } from "@t45/contracts/models/Notification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Notification.fields,
  isRead: Schema.BooleanFromBit,
}).pipe(Schema.decodeTo(Schema.toType(Notification)));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, kind, step_id AS "stepId", workflow_id AS "workflowId",
  read_at IS NOT NULL AS "isRead", created_at AS "createdAt"`;

export class NotificationRepository extends Context.Service<
  NotificationRepository,
  {
    readonly insert: (userId: string, notification: Notification) => Effect.Effect<void>;
    readonly list: (userId: string, limit: number) => Effect.Effect<ReadonlyArray<Notification>>;
    readonly get: (id: string, userId: string) => Effect.Effect<Notification | null>;
    readonly unreadCount: (userId: string) => Effect.Effect<number>;
    readonly hasUnreadNotice: (input: {
      readonly userId: string;
      readonly kind: NotificationKind;
      readonly workflowId: string;
    }) => Effect.Effect<boolean>;
    readonly markRead: (input: {
      readonly id: string;
      readonly userId: string;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void>;
    readonly markReadForStep: (input: {
      readonly userId: string;
      readonly stepId: string;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void>;
  }
>()("t45/workflows/NotificationRepository") {}

export const layer = Layer.effect(
  NotificationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: string, params: ReadonlyArray<string | number>) =>
      sql
        .unsafe(`SELECT ${COLUMNS} FROM workflow_notifications WHERE ${where}`, [...params])
        .pipe(Effect.flatMap(decodeRows), Effect.orDie);

    return NotificationRepository.of({
      insert: (userId, notification) =>
        Effect.gen(function* () {
          const row = yield* encodeRow(notification);
          yield* sql`INSERT INTO workflow_notifications (id, user_id, kind, workflow_id, step_id,
            created_at)
            VALUES (${row.id}, ${userId}, ${row.kind}, ${row.workflowId},
              ${row.stepId}, ${row.createdAt})`;
        }).pipe(Effect.orDie),
      list: (userId, limit) =>
        read("user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", [userId, limit]),
      get: (id, userId) =>
        read("id = ? AND user_id = ?", [id, userId]).pipe(
          Effect.map(([notification]) => notification ?? null),
        ),
      unreadCount: (userId) =>
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM workflow_notifications
          WHERE user_id = ${userId} AND read_at IS NULL`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
          Effect.orDie,
        ),
      hasUnreadNotice: (input) =>
        sql`SELECT id FROM workflow_notifications WHERE user_id = ${input.userId}
          AND kind = ${input.kind} AND workflow_id = ${input.workflowId}
          AND step_id IS NULL AND read_at IS NULL LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      markRead: (input) =>
        sql`UPDATE workflow_notifications SET read_at = ${DateTime.formatIso(input.at)}
          WHERE id = ${input.id} AND user_id = ${input.userId} AND read_at IS NULL`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      markReadForStep: (input) =>
        sql`UPDATE workflow_notifications SET read_at = ${DateTime.formatIso(input.at)}
          WHERE user_id = ${input.userId} AND step_id = ${input.stepId} AND read_at IS NULL`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    });
  }),
);
