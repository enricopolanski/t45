import { Workflow, WorkflowVersion } from "@t45/contracts/models/Workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  ...Workflow.fields,
  editorUserIds: Schema.fromJsonString(Workflow.fields.editorUserIds),
  isArchived: Schema.BooleanFromBit,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeRow = Schema.encodeEffect(Row);
const VersionRow = Schema.Struct({
  ...WorkflowVersion.fields,
  isFrozen: Schema.BooleanFromBit,
  steps: Schema.fromJsonString(WorkflowVersion.fields.steps),
});
const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(VersionRow));
const encodeVersion = Schema.encodeEffect(VersionRow);

const COLUMNS = `id, name, creator_user_id AS "creatorUserId", editor_user_ids AS "editorUserIds",
  is_archived AS "isArchived"`;
const VERSION_COLUMNS = `id, workflow_id AS "workflowId", number, revision,
  is_frozen AS "isFrozen", steps`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${COLUMNS} FROM workflows WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeRows), Effect.orDie);
  const readVersions = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe(`SELECT ${VERSION_COLUMNS} FROM workflow_versions WHERE ${where}`, [...params])
      .pipe(Effect.flatMap(decodeVersions), Effect.orDie);

  return {
    list: read("1 = 1 ORDER BY name COLLATE NOCASE, id", []),
    get: (id: string) => read("id = ?", [id]).pipe(Effect.map(([workflow]) => workflow ?? null)),
    /** The workflows with a version in which a step runs the automation. */
    listAttaching: (automationId: string) =>
      read(
        `EXISTS (SELECT 1 FROM workflow_versions v, json_tree(v.steps) node
          WHERE v.workflow_id = workflows.id AND node.path LIKE '%.automationIds'
            AND node.atom = ?)`,
        [automationId],
      ),
    /** Inserts the workflow, or replaces the one with its id. */
    save: (workflow: Workflow) =>
      Effect.gen(function* () {
        const row = yield* encodeRow(workflow);
        yield* sql`INSERT INTO workflows (id, name, creator_user_id, editor_user_ids, is_archived)
            VALUES (${row.id}, ${row.name}, ${row.creatorUserId}, ${row.editorUserIds},
              ${row.isArchived})
            ON CONFLICT (id) DO UPDATE SET name = excluded.name,
              editor_user_ids = excluded.editor_user_ids, is_archived = excluded.is_archived`;
      }).pipe(Effect.orDie),
    versions: {
      get: (id: string) =>
        readVersions("id = ?", [id]).pipe(Effect.map(([version]) => version ?? null)),
      /** Every version of the workflow, oldest first: never empty for a workflow that exists. */
      listForWorkflow: (workflowId: string) =>
        readVersions("workflow_id = ? ORDER BY number", [workflowId]),
      /** Inserts the version, or replaces the steps, revision and frozen state of the one with its id. */
      save: (version: WorkflowVersion) =>
        Effect.gen(function* () {
          const row = yield* encodeVersion(version);
          yield* sql`INSERT INTO workflow_versions (id, workflow_id, number, revision, is_frozen,
                steps)
              VALUES (${row.id}, ${row.workflowId}, ${row.number}, ${row.revision},
                ${row.isFrozen}, ${row.steps})
              ON CONFLICT (id) DO UPDATE SET revision = excluded.revision,
                is_frozen = excluded.is_frozen, steps = excluded.steps`;
        }).pipe(Effect.orDie),
    },
  };
});

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  Effect.Success<typeof make>
>()("t45/workflows/WorkflowRepository") {}

export const layer = Layer.effect(WorkflowRepository, make);
