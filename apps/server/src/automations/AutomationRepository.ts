import { Automation, type AutomationId } from "@t45/contracts/models/Automation";
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

const COLUMNS = `id, title, prompt, agent_id AS "agentId", is_archived AS "isArchived",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  const list = sql`SELECT ${columns}, (
      SELECT json_object('status', c.status, 'at', c.updated_at)
      FROM chat_origins o JOIN chats c ON c.id = o.chat_id
      WHERE json_extract(o.trigger, '$.automationId') = automations.id
      ORDER BY c.created_at DESC, c.id DESC LIMIT 1
    ) AS "lastRun" FROM automations WHERE is_archived = 0 ORDER BY created_at, id`.pipe(
    Effect.flatMap(decodeSummaries),
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
    list: list.pipe(
      Effect.map((automations) =>
        automations.map(({ lastRun, ...automation }) => ({
          ...automation,
          lastRun:
            lastRun === null
              ? null
              : { at: lastRun.at, statusLabel: lastRun.status === "running" ? "Running" : "Ended" },
        })),
      ),
    ),
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
    archive: (id: AutomationId, at: DateTime.Utc) =>
      sql`UPDATE automations SET is_archived = 1, updated_at = ${DateTime.formatIso(at)}
          WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
  };
});

export class AutomationRepository extends Context.Service<
  AutomationRepository,
  Effect.Success<typeof make>
>()("t45/automations/AutomationRepository") {}
export const layer = Layer.effect(AutomationRepository, make);
