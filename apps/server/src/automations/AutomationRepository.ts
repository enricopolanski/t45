import {
  Automation,
  type AutomationId,
  Schedule,
  ScheduleTrigger,
  type ScheduleTriggerId,
} from "@t45/contracts/models/Automation";
import { Chat, ChatStatus } from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({ ...Automation.fields, isArchived: Schema.BooleanFromBit });
const encodeAutomation = Schema.encodeEffect(Row);
const decodeAutomations = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeSummaries = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Row.fields,
      lastRun: Schema.NullOr(
        Schema.fromJsonString(
          Schema.Struct({
            status: Schema.NullOr(ChatStatus),
            at: Chat.fields.lastActivityAt,
          }),
        ),
      ),
    }),
  ),
);
const TriggerRow = Schema.Struct({
  ...ScheduleTrigger.fields,
  schedule: Schema.fromJsonString(Schedule),
});
const decodeTriggers = Schema.decodeUnknownEffect(Schema.Array(TriggerRow));
const encodeTrigger = Schema.encodeEffect(TriggerRow);

const COLUMNS = `id, title, prompt, agent_id AS "agentId", is_archived AS "isArchived",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const TRIGGER_COLUMNS = `id, automation_id AS "automationId", creator_user_id AS "creatorUserId",
  schedule_json AS "schedule", status, next_run_at AS "nextRunAt", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);
  const triggerColumns = sql.literal(TRIGGER_COLUMNS);

  const list = sql`SELECT ${columns}, (
      SELECT json_object('status', c.status, 'at', c.updated_at)
      FROM chat_origins o JOIN chats c ON c.id = o.chat_id
      WHERE json_extract(o.trigger, '$.automationId') = automations.id
      ORDER BY c.created_at DESC, c.id DESC LIMIT 1
    ) AS "lastRun" FROM automations WHERE is_archived = 0 ORDER BY created_at, id`.pipe(
    Effect.flatMap(decodeSummaries),
    Effect.orDie,
  );
  const liveTriggers = sql`SELECT ${triggerColumns} FROM schedule_triggers
      WHERE status != 'archived' ORDER BY created_at, id`.pipe(
    Effect.flatMap(decodeTriggers),
    Effect.orDie,
  );
  /** An archived trigger is as good as missing: nothing reads or changes it again. */
  const getTrigger = (id: ScheduleTriggerId) =>
    sql`SELECT ${triggerColumns} FROM schedule_triggers
        WHERE id = ${id} AND status != 'archived'`.pipe(
      Effect.flatMap(decodeTriggers),
      Effect.map((triggers) => triggers[0] ?? null),
      Effect.orDie,
    );

  /** An archived automation is as good as missing: nothing runs or changes it again. */
  const get = (id: AutomationId) =>
    sql`SELECT ${columns} FROM automations WHERE id = ${id} AND is_archived = 0`.pipe(
      Effect.flatMap(decodeAutomations),
      Effect.map((automations) => automations[0] ?? null),
      Effect.orDie,
    );
  /** Inserts the automation, or replaces the one with its id. */
  const save = (automation: Automation) =>
    Effect.gen(function* () {
      const row = yield* encodeAutomation(automation);
      yield* sql`INSERT INTO automations (id, title, prompt, agent_id, created_at, updated_at)
          VALUES (${row.id}, ${row.title}, ${row.prompt}, ${row.agentId}, ${row.createdAt},
            ${row.updatedAt})
          ON CONFLICT (id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt,
            agent_id = excluded.agent_id, updated_at = excluded.updated_at`;
    }).pipe(Effect.orDie);

  return {
    list: Effect.gen(function* () {
      const triggers = yield* liveTriggers;
      return (yield* list).map(({ lastRun, ...automation }) => ({
        ...automation,
        scheduleTriggers: triggers.filter((trigger) => trigger.automationId === automation.id),
        lastRun:
          lastRun === null
            ? null
            : { at: lastRun.at, statusLabel: lastRun.status === "running" ? "Running" : "Ended" },
      }));
    }),
    get,
    /** The agent's automations, without the archived ones. */
    listForAgent: (agentId: string) =>
      sql`SELECT ${columns} FROM automations WHERE agent_id = ${agentId} AND is_archived = 0`.pipe(
        Effect.flatMap(decodeAutomations),
        Effect.orDie,
      ),
    save,
    /** Reads the automation and writes its change in one transaction; null when there is none. */
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
            yield* save(automation);
            return automation;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: Effect.die })),
    /** Archives the automation and its schedules together. */
    archive: (id: AutomationId, at: DateTime.Utc) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(at);
        yield* sql`UPDATE automations SET is_archived = 1, updated_at = ${now} WHERE id = ${id}`;
        yield* sql`UPDATE schedule_triggers
            SET status = 'archived', next_run_at = NULL, updated_at = ${now}
            WHERE automation_id = ${id} AND status != 'archived'`;
      }).pipe(sql.withTransaction, Effect.orDie),
    triggers: {
      insert: (trigger: ScheduleTrigger) =>
        Effect.gen(function* () {
          const row = yield* encodeTrigger(trigger);
          yield* sql`INSERT INTO schedule_triggers (id, automation_id, creator_user_id,
              schedule_json, status, next_run_at, last_error, created_at, updated_at)
            VALUES (${row.id}, ${row.automationId}, ${row.creatorUserId}, ${row.schedule},
              ${row.status}, ${row.nextRunAt}, ${row.lastError}, ${row.createdAt},
              ${row.updatedAt})`;
        }).pipe(Effect.orDie),
      /** Reads the trigger and writes its change in one transaction; null when there is none. */
      modify: <E, R>(
        id: ScheduleTriggerId,
        change: (current: ScheduleTrigger) => Effect.Effect<ScheduleTrigger, E, R>,
      ) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* getTrigger(id);
              if (current === null) return null;
              const trigger = yield* change(current);
              const row = yield* encodeTrigger(trigger).pipe(Effect.orDie);
              yield* sql`UPDATE schedule_triggers SET status = ${row.status},
                  next_run_at = ${row.nextRunAt}, last_error = ${row.lastError},
                  updated_at = ${row.updatedAt}
                WHERE id = ${id}`;
              return trigger;
            }),
          )
          .pipe(Effect.catchTags({ SqlError: Effect.die })),
      due: (now: DateTime.Utc) =>
        sql<{ readonly id: ScheduleTriggerId }>`SELECT id FROM schedule_triggers
            WHERE status = 'enabled' AND next_run_at IS NOT NULL
              AND next_run_at <= ${DateTime.formatIso(now)}
            ORDER BY next_run_at, id`.pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.orDie,
        ),
      archiveCreatedBy: (userId: string, at: DateTime.Utc) =>
        sql`UPDATE schedule_triggers
            SET status = 'archived', next_run_at = NULL, updated_at = ${DateTime.formatIso(at)}
            WHERE creator_user_id = ${userId} AND status != 'archived'`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    },
  };
});

export class AutomationRepository extends Context.Service<
  AutomationRepository,
  Effect.Success<typeof make>
>()("t45/automations/AutomationRepository") {}
export const layer = Layer.effect(AutomationRepository, make);
