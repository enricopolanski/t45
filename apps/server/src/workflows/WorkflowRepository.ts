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
  isDefault: Schema.BooleanFromBit,
  isPublic: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, definition_id AS "definitionId", name, responsible_user_id AS "responsible",
  admin_user_ids AS "adminUserIds", default_assignments AS "defaultAssignments", slug,
  is_default AS "isDefault", is_public AS "isPublic", archived_at AS "archivedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Workflow>>;
    readonly get: (id: string) => Effect.Effect<Workflow | null>;
    readonly getByIdOrSlug: (idOrSlug: string) => Effect.Effect<Workflow | null>;
    readonly listForDefinition: (definitionId: string) => Effect.Effect<ReadonlyArray<Workflow>>;
    readonly insert: (workflow: Workflow) => Effect.Effect<void>;
    readonly update: (workflow: Workflow) => Effect.Effect<void, Refused>;
    readonly remove: (id: string) => Effect.Effect<void>;
  }
>()("t45/workflows/WorkflowRepository") {}

export const layer = Layer.effect(
  WorkflowRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: string, params: ReadonlyArray<string>) =>
      sql
        .unsafe(`SELECT ${COLUMNS} FROM workflows WHERE ${where}`, [...params])
        .pipe(Effect.flatMap(decodeRows), Effect.orDie);
    const first = Effect.map(([workflow]: ReadonlyArray<Workflow>) => workflow ?? null);

    return WorkflowRepository.of({
      list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
      get: (id) => read("id = ?", [id]).pipe(first),
      getByIdOrSlug: (idOrSlug) =>
        read("id = ? OR slug = ? ORDER BY id = ? DESC LIMIT 1", [
          idOrSlug,
          idOrSlug,
          idOrSlug,
        ]).pipe(first),
      listForDefinition: (definitionId) =>
        read("definition_id = ? ORDER BY name COLLATE NOCASE, id", [definitionId]),
      insert: (workflow) =>
        Effect.gen(function* () {
          const row = yield* encodeRow(workflow);
          yield* sql`INSERT INTO workflows (id, definition_id, name, responsible_user_id,
              admin_user_ids, default_assignments, slug, is_default, is_public, archived_at,
              created_at, updated_at)
            VALUES (${row.id}, ${row.definitionId}, ${row.name}, ${row.responsible},
              ${row.adminUserIds}, ${row.defaultAssignments}, ${row.slug}, ${row.isDefault},
              ${row.isPublic}, ${row.archivedAt}, ${row.createdAt}, ${row.updatedAt})`;
        }).pipe(Effect.orDie),
      update: (workflow) =>
        Effect.gen(function* () {
          if (workflow.slug !== null) {
            const taken = yield* sql`SELECT id FROM workflows
              WHERE (slug = ${workflow.slug} OR id = ${workflow.slug}) AND id <> ${workflow.id}
              LIMIT 1`.pipe(Effect.orDie);
            if (taken.length > 0) return yield* new Refused({ reason: "slug_taken" });
          }
          const row = yield* encodeRow(workflow).pipe(Effect.orDie);
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                if (workflow.isDefault) {
                  yield* sql`UPDATE workflows SET is_default = 0, updated_at = ${row.updatedAt}
                    WHERE is_default = 1 AND id <> ${row.id}`;
                }
                yield* sql`UPDATE workflows SET name = ${row.name},
                    responsible_user_id = ${row.responsible}, admin_user_ids = ${row.adminUserIds},
                    default_assignments = ${row.defaultAssignments}, slug = ${row.slug},
                    is_default = ${row.isDefault}, is_public = ${row.isPublic},
                    archived_at = ${row.archivedAt}, updated_at = ${row.updatedAt}
                  WHERE id = ${row.id}`;
              }),
            )
            .pipe(Effect.orDie);
        }),
      remove: (id) => sql`DELETE FROM workflows WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
