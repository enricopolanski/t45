import { Schedule, Automation, type AutomationId } from "@t45/contracts/models/Automation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Automation.fields,
  isEnabled: Schema.BooleanFromBit,
  schedule: Schema.fromJsonString(Schedule),
});
const decodeAutomations = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, title, prompt, agent_id AS "agentId", is_enabled AS "isEnabled",
  schedule_json AS "schedule", webhook_token AS "webhookToken", next_run_at AS "nextRunAt",
  last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);
  const one = <E, R>(rows: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    rows.pipe(
      Effect.flatMap(decodeAutomations),
      Effect.map((automations) => automations[0] ?? null),
      Effect.orDie,
    );

  const get = (id: AutomationId) => one(sql`SELECT ${columns} FROM automations WHERE id = ${id}`);

  return {
    list: sql`SELECT ${columns} FROM automations ORDER BY created_at, id`.pipe(
      Effect.flatMap(decodeAutomations),
      Effect.orDie,
    ),
    get,
    insert: (automation: Automation) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(automation);
        yield* sql`INSERT INTO automations (id, title, prompt, agent_id, is_enabled, schedule_json,
            webhook_token, next_run_at, last_error, created_at, updated_at)
          VALUES (${row.id}, ${row.title}, ${row.prompt}, ${row.agentId},
            ${row.isEnabled}, ${row.schedule}, ${row.webhookToken},
            ${row.nextRunAt}, ${row.lastError}, ${row.createdAt}, ${row.updatedAt})`;
      }).pipe(Effect.orDie),
    setLastError: (id: AutomationId, error: string | null) =>
      sql`UPDATE automations SET last_error = ${error} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    modify: <E, R>(
      id: AutomationId,
      change: (current: Automation) => Effect.Effect<Automation, E, R>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(id);
            if (current === null) return null;
            const automation = yield* change(current);
            const row = yield* encodeRow(automation).pipe(Effect.orDie);
            return yield* one(
              sql`UPDATE automations SET title = ${row.title}, prompt = ${row.prompt},
                    agent_id = ${row.agentId}, is_enabled = ${row.isEnabled},
                    schedule_json = ${row.schedule},
                    webhook_token = ${row.webhookToken}, next_run_at = ${row.nextRunAt}, last_error = ${row.lastError},
                    updated_at = ${row.updatedAt}
                  WHERE id = ${id}
                  RETURNING ${columns}`,
            );
          }),
        )
        .pipe(Effect.catchTags({ SqlError: Effect.die })),
    due: (now: DateTime.Utc) =>
      sql<{ readonly id: AutomationId }>`SELECT id FROM automations
          WHERE is_enabled = 1 AND next_run_at IS NOT NULL
            AND next_run_at <= ${DateTime.formatIso(now)}
          ORDER BY next_run_at, id`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),
  };
});

export class AutomationRepository extends Context.Service<
  AutomationRepository,
  Effect.Success<typeof make>
>()("t45/automations/AutomationRepository") {}
export const layer = Layer.effect(AutomationRepository, make);
