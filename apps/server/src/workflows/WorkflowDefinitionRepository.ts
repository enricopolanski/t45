import { WorkflowDefinition } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...WorkflowDefinition.fields,
  steps: Schema.fromJsonString(WorkflowDefinition.fields.steps),
  isArchived: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, name, steps, is_archived AS "isArchived"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM workflow_definitions WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);

  return {
    list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
    get: (id: string) =>
      read("id = ?", [id]).pipe(Effect.map(([definition]) => definition ?? null)),
    insert: (definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(definition);
        yield* sql`INSERT INTO workflow_definitions (id, name, steps, is_archived)
            VALUES (${row.id}, ${row.name}, ${row.steps}, ${row.isArchived})`;
      }).pipe(Effect.orDie),
    update: (definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(definition);
        yield* sql`UPDATE workflow_definitions SET name = ${row.name}, steps = ${row.steps},
              is_archived = ${row.isArchived}
            WHERE id = ${row.id}`;
      }).pipe(Effect.orDie),
  };
});

export class WorkflowDefinitionRepository extends Context.Service<
  WorkflowDefinitionRepository,
  Effect.Success<typeof make>
>()("t45/workflows/WorkflowDefinitionRepository") {}

export const layer = Layer.effect(WorkflowDefinitionRepository, make);
