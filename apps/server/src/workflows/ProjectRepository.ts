import { Refused, Project } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Project.fields,
  adminUserIds: Schema.fromJsonString(Project.fields.adminUserIds),
  defaultAssignments: Schema.fromJsonString(Project.fields.defaultAssignments),
  isPublic: Schema.BooleanFromBit,
  isArchived: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, workflow_id AS "workflowId", name, responsible_user_id AS "responsible",
  admin_user_ids AS "adminUserIds", default_assignments AS "defaultAssignments", slug,
  is_public AS "isPublic", is_archived AS "isArchived"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM projects WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
  const first = Effect.map(([project]: ReadonlyArray<Project>) => project ?? null);

  return {
    list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
    get: (id: string) => read("id = ?", [id]).pipe(first),
    getByIdOrSlug: (idOrSlug: string) =>
      read("id = ? OR slug = ? ORDER BY id = ? DESC LIMIT 1", [idOrSlug, idOrSlug, idOrSlug]).pipe(
        first,
      ),
    listForWorkflow: (workflowId: string) =>
      read("workflow_id = ? ORDER BY name COLLATE NOCASE, id", [workflowId]),
    insert: (project: Project) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(project);
        yield* sql`INSERT INTO projects (id, workflow_id, name, responsible_user_id,
              admin_user_ids, default_assignments, slug, is_public, is_archived)
            VALUES (${row.id}, ${row.workflowId}, ${row.name}, ${row.responsible},
              ${row.adminUserIds}, ${row.defaultAssignments}, ${row.slug},
              ${row.isPublic}, ${row.isArchived})`;
      }).pipe(Effect.orDie),
    update: (project: Project) =>
      Effect.gen(function* () {
        if (project.slug !== null) {
          const taken = yield* sql`SELECT id FROM projects
              WHERE (slug = ${project.slug} OR id = ${project.slug}) AND id <> ${project.id}
              LIMIT 1`.pipe(Effect.orDie);
          if (taken.length > 0) return yield* new Refused({ reason: "slug_taken" });
        }
        const row = yield* encodeRow(project).pipe(Effect.orDie);
        yield* sql`UPDATE projects SET name = ${row.name},
              responsible_user_id = ${row.responsible}, admin_user_ids = ${row.adminUserIds},
              default_assignments = ${row.defaultAssignments}, slug = ${row.slug},
              is_public = ${row.isPublic}, is_archived = ${row.isArchived}
            WHERE id = ${row.id}`.pipe(Effect.orDie);
      }),
    remove: (id: string) =>
      sql`DELETE FROM projects WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
  };
});

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  Effect.Success<typeof make>
>()("t45/workflows/ProjectRepository") {}

export const layer = Layer.effect(ProjectRepository, make);
