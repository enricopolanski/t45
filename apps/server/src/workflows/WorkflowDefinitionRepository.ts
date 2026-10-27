import { WorkflowDefinition } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...WorkflowDefinition.fields,
  steps: Schema.fromJsonString(WorkflowDefinition.fields.steps),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, name, steps, archived_at AS "archivedAt", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export class WorkflowDefinitionRepository extends Context.Service<
  WorkflowDefinitionRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<WorkflowDefinition>>;
    readonly get: (id: string) => Effect.Effect<WorkflowDefinition | null>;
    readonly insert: (definition: WorkflowDefinition) => Effect.Effect<void>;
    readonly update: (definition: WorkflowDefinition) => Effect.Effect<void>;
  }
>()("t45/workflows/WorkflowDefinitionRepository") {}

export const layer = Layer.effect(
  WorkflowDefinitionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: string, params: ReadonlyArray<string>) =>
      sql
        .unsafe(`SELECT ${COLUMNS} FROM workflow_definitions WHERE ${where}`, [...params])
        .pipe(Effect.flatMap(decodeRows), Effect.orDie);

    return WorkflowDefinitionRepository.of({
      list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
      get: (id) => read("id = ?", [id]).pipe(Effect.map(([definition]) => definition ?? null)),
      insert: (definition) =>
        Effect.gen(function* () {
          const row = yield* encodeRow(definition);
          yield* sql`INSERT INTO workflow_definitions (id, name, steps, archived_at, created_at,
              updated_at)
            VALUES (${row.id}, ${row.name}, ${row.steps}, ${row.archivedAt}, ${row.createdAt},
              ${row.updatedAt})`;
        }).pipe(Effect.orDie),
      update: (definition) =>
        Effect.gen(function* () {
          const row = yield* encodeRow(definition);
          yield* sql`UPDATE workflow_definitions SET name = ${row.name}, steps = ${row.steps},
              archived_at = ${row.archivedAt}, updated_at = ${row.updatedAt}
            WHERE id = ${row.id}`;
        }).pipe(Effect.orDie),
    });
  }),
);
