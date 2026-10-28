import { Refused, Workflow } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Workflow.fields,
  adminUserIds: Schema.fromJsonString(Workflow.fields.adminUserIds),
  defaultAssignments: Schema.fromJsonString(Workflow.fields.defaultAssignments),
  isPublic: Schema.BooleanFromBit,
  isArchived: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, definition_id AS "definitionId", name, responsible_user_id AS "responsible",
  admin_user_ids AS "adminUserIds", default_assignments AS "defaultAssignments", slug,
  is_public AS "isPublic", is_archived AS "isArchived"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM workflows WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
  const first = Effect.map(([workflow]: ReadonlyArray<Workflow>) => workflow ?? null);

  return {
    list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
    get: (id: string) => read("id = ?", [id]).pipe(first),
    getByIdOrSlug: (idOrSlug: string) =>
      read("id = ? OR slug = ? ORDER BY id = ? DESC LIMIT 1", [idOrSlug, idOrSlug, idOrSlug]).pipe(
        first,
      ),
    listForDefinition: (definitionId: string) =>
      read("definition_id = ? ORDER BY name COLLATE NOCASE, id", [definitionId]),
    insert: (workflow: Workflow) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(workflow);
        yield* sql`INSERT INTO workflows (id, definition_id, name, responsible_user_id,
              admin_user_ids, default_assignments, slug, is_public, is_archived)
            VALUES (${row.id}, ${row.definitionId}, ${row.name}, ${row.responsible},
              ${row.adminUserIds}, ${row.defaultAssignments}, ${row.slug},
              ${row.isPublic}, ${row.isArchived})`;
      }).pipe(Effect.orDie),
    update: (workflow: Workflow) =>
      Effect.gen(function* () {
        if (workflow.slug !== null) {
          const taken = yield* sql`SELECT id FROM workflows
              WHERE (slug = ${workflow.slug} OR id = ${workflow.slug}) AND id <> ${workflow.id}
              LIMIT 1`.pipe(Effect.orDie);
          if (taken.length > 0) return yield* new Refused({ reason: "slug_taken" });
        }
        const row = yield* encodeRow(workflow).pipe(Effect.orDie);
        yield* sql`UPDATE workflows SET name = ${row.name},
              responsible_user_id = ${row.responsible}, admin_user_ids = ${row.adminUserIds},
              default_assignments = ${row.defaultAssignments}, slug = ${row.slug},
              is_public = ${row.isPublic}, is_archived = ${row.isArchived}
            WHERE id = ${row.id}`.pipe(Effect.orDie);
      }),
    remove: (id: string) =>
      sql`DELETE FROM workflows WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
  };
});

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  Effect.Success<typeof make>
>()("t45/workflows/WorkflowRepository") {}

export const layer = Layer.effect(WorkflowRepository, make);
