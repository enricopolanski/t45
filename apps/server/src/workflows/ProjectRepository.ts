import { Refused, Project } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Project.fields,
  adminUserIds: Schema.fromJsonString(Project.fields.adminUserIds),
  defaultAssignees: Schema.fromJsonString(Project.fields.defaultAssignees),
  isArchived: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);

const COLUMNS = `id, workflow_id AS "workflowId", workflow_version_id AS "workflowVersionId", name,
  admin_user_ids AS "adminUserIds", default_assignees AS "defaultAssignees", slug,
  is_archived AS "isArchived"`;

/** A member of one of the workflow's steps in a project; `stepId` is the step's definition id. */
interface StepMember {
  readonly projectId: string;
  readonly stepId: string;
  readonly userId: string;
}
const MEMBER_COLUMNS = `project_id AS "projectId", step_id AS "stepId", user_id AS "userId"`;

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
        yield* sql`INSERT INTO projects (id, workflow_id, workflow_version_id, name,
              admin_user_ids, default_assignees, slug, is_archived)
            VALUES (${row.id}, ${row.workflowId}, ${row.workflowVersionId}, ${row.name},
              ${row.adminUserIds}, ${row.defaultAssignees}, ${row.slug}, ${row.isArchived})`;
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
              workflow_version_id = ${row.workflowVersionId},
              admin_user_ids = ${row.adminUserIds},
              default_assignees = ${row.defaultAssignees}, slug = ${row.slug},
              is_archived = ${row.isArchived}
            WHERE id = ${row.id}`.pipe(Effect.orDie);
      }),
    members: {
      listForProject: (projectId: string) =>
        sql<StepMember>`SELECT ${sql.literal(MEMBER_COLUMNS)} FROM step_members
            WHERE project_id = ${projectId} ORDER BY step_id, user_id`.pipe(Effect.orDie),
      /** The definition ids of the workflow's steps `userId` is a member of in the project. */
      stepIdsOf: (projectId: string, userId: string) =>
        sql<{ readonly stepId: string }>`SELECT step_id AS "stepId" FROM step_members
            WHERE project_id = ${projectId} AND user_id = ${userId}`.pipe(
          Effect.map((rows) => rows.map((row) => row.stepId)),
          Effect.orDie,
        ),
      listForUser: (userId: string) =>
        sql<StepMember>`SELECT ${sql.literal(MEMBER_COLUMNS)} FROM step_members
            WHERE user_id = ${userId}`.pipe(Effect.orDie),
      /** Adding someone who already is a member changes nothing. */
      add: (member: StepMember) =>
        sql`INSERT INTO step_members (project_id, step_id, user_id)
            VALUES (${member.projectId}, ${member.stepId}, ${member.userId})
            ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.orDie),
      remove: (member: StepMember) =>
        sql`DELETE FROM step_members WHERE project_id = ${member.projectId}
            AND step_id = ${member.stepId} AND user_id = ${member.userId}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    },
  };
});

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  Effect.Success<typeof make>
>()("t45/workflows/ProjectRepository") {}

export const layer = Layer.effect(ProjectRepository, make);
