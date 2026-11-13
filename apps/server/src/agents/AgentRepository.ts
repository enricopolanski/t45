import { Agent, Refused } from "@t45/contracts/models/Agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const decodeAgents = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(Agent)));
const encodeAgent = Schema.encodeEffect(
  Schema.Struct({
    ...Agent.fields,
    files: Schema.fromJsonString(Agent.fields.files),
    isConversational: Schema.BooleanFromBit,
    isPublished: Schema.BooleanFromBit,
  }),
);

export class AgentRepository extends Context.Service<
  AgentRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Agent>>;
    readonly get: (id: string) => Effect.Effect<Agent | null>;
    readonly save: (agent: Agent) => Effect.Effect<void, Refused>;
    /** Reads the agent and writes its change in one transaction; null when there is none. */
    readonly modify: (
      id: string,
      change: (current: Agent) => Effect.Effect<Agent, Refused>,
    ) => Effect.Effect<Agent | null, Refused>;
  }
>()("t45/agents/AgentRepository") {}

export const layer = Layer.effect(
  AgentRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: Fragment) =>
      sql<{ readonly agent: string }>`SELECT json_object(
          'id', id, 'name', name, 'instructions', instructions, 'model', model,
          'files', json(files),
          'skills', json((SELECT json_group_array(skill_id) FROM agent_skills
            WHERE agent_id = agents.id)),
          'capabilities', json((SELECT json_group_array(capability_id) FROM agent_capabilities
            WHERE agent_id = agents.id)),
          'permissions', json_object('network', network),
          'isConversational', json(CASE WHEN is_conversational THEN 'true' ELSE 'false' END),
          'creatorUserId', creator_user_id,
          'isPublished', json(CASE WHEN is_published THEN 'true' ELSE 'false' END),
          'status', status, 'createdAt', created_at, 'updatedAt', updated_at) AS agent
        FROM agents WHERE ${where} ORDER BY name COLLATE NOCASE`.pipe(
        Effect.flatMap((rows) => decodeAgents(rows.map((row) => row.agent))),
        Effect.orDie,
      );
    const requireNameFree = (agent: Pick<Agent, "id" | "name">) =>
      sql<{
        readonly id: string;
      }>`SELECT id FROM agents WHERE name = ${agent.name} COLLATE NOCASE`.pipe(
        Effect.flatMap((taken) =>
          taken.some((row) => row.id !== agent.id)
            ? new Refused({ reason: "name_taken" })
            : Effect.void,
        ),
      );

    const save = (agent: Agent) =>
      Effect.gen(function* () {
        const row = yield* encodeAgent(agent).pipe(Effect.orDie);
        yield* requireNameFree(row);
        yield* sql`INSERT INTO agents (id, name, instructions, model, files, network,
            is_conversational, creator_user_id, is_published, status, created_at,
            updated_at)
          VALUES (${row.id}, ${row.name}, ${row.instructions}, ${row.model}, ${row.files},
            ${row.permissions.network},
            ${row.isConversational}, ${row.creatorUserId}, ${row.isPublished}, ${row.status},
            ${row.createdAt}, ${row.updatedAt})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name,
            instructions = excluded.instructions, model = excluded.model, files = excluded.files,
            network = excluded.network,
            is_conversational = excluded.is_conversational, is_published = excluded.is_published,
            status = excluded.status, updated_at = excluded.updated_at`;
        yield* sql`DELETE FROM agent_skills WHERE agent_id = ${agent.id}`;
        for (const skillId of new Set(agent.skills)) {
          yield* sql`INSERT INTO agent_skills (agent_id, skill_id) VALUES (${agent.id}, ${skillId})`;
        }
        yield* sql`DELETE FROM agent_capabilities WHERE agent_id = ${agent.id}`;
        for (const capabilityId of new Set(agent.capabilities)) {
          yield* sql`INSERT INTO agent_capabilities (agent_id, capability_id)
            VALUES (${agent.id}, ${capabilityId})`;
        }
      }).pipe(sql.withTransaction, Effect.catchTags({ SqlError: Effect.die }));

    return AgentRepository.of({
      list: read(sql`1 = 1`),
      get: (agentId) => read(sql`id = ${agentId}`).pipe(Effect.map(([agent]) => agent ?? null)),
      save,
      modify: (id, change) =>
        Effect.gen(function* () {
          const [current] = yield* read(sql`id = ${id}`);
          if (current === undefined) return null;
          const agent = yield* change(current);
          yield* save(agent);
          return agent;
        }).pipe(sql.withTransaction, Effect.catchTags({ SqlError: Effect.die })),
    });
  }),
);
