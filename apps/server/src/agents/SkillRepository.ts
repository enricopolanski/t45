import { Refused, Skill } from "@t45/contracts/models/Skill";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const decodeSkills = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(Skill)));
const encodeSkill = Schema.encodeEffect(
  Schema.Struct({ ...Skill.fields, files: Schema.fromJsonString(Skill.fields.files) }),
);

export class SkillRepository extends Context.Service<
  SkillRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Skill>>;
    readonly get: (skillId: string) => Effect.Effect<Skill | null>;
    readonly listForAgent: (agentId: string) => Effect.Effect<ReadonlyArray<Skill>>;
    readonly save: (skill: Skill) => Effect.Effect<void, Refused>;
    readonly remove: (skillId: string) => Effect.Effect<boolean>;
  }
>()("t45/agents/SkillRepository") {}

export const layer = Layer.effect(
  SkillRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: Fragment) =>
      sql<{ readonly skill: string }>`SELECT json_object(
          'id', id, 'name', name, 'description', description, 'content', content,
          'files', json(files), 'createdAt', created_at, 'updatedAt', updated_at) AS skill
        FROM skills WHERE ${where} ORDER BY name`.pipe(
        Effect.flatMap((rows) => decodeSkills(rows.map((row) => row.skill))),
        Effect.orDie,
      );
    const requireNameFree = (skill: Pick<Skill, "id" | "name">) =>
      sql<{ readonly id: string }>`SELECT id FROM skills WHERE name = ${skill.name}`.pipe(
        Effect.flatMap((taken) =>
          taken.some((row) => row.id !== skill.id)
            ? new Refused({ reason: "name_taken" })
            : Effect.void,
        ),
      );

    return SkillRepository.of({
      list: read(sql`1 = 1`),
      get: (skillId) => read(sql`id = ${skillId}`).pipe(Effect.map(([skill]) => skill ?? null)),
      listForAgent: (agentId) =>
        read(sql`id IN (SELECT skill_id FROM agent_skills WHERE agent_id = ${agentId})`),
      save: (skill) =>
        Effect.gen(function* () {
          yield* requireNameFree(skill);
          const row = yield* encodeSkill(skill).pipe(Effect.orDie);
          yield* sql`INSERT INTO skills (id, name, description, content, files, created_at,
              updated_at)
            VALUES (${row.id}, ${row.name}, ${row.description}, ${row.content}, ${row.files},
              ${row.createdAt}, ${row.updatedAt})
            ON CONFLICT (id) DO UPDATE SET name = excluded.name,
              description = excluded.description, content = excluded.content,
              files = excluded.files, updated_at = excluded.updated_at`;
        }).pipe(sql.withTransaction, Effect.catchTags({ SqlError: Effect.die })),
      remove: (skillId) =>
        sql`DELETE FROM skills WHERE id = ${skillId} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
    });
  }),
);
