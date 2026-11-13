import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Each of T45's former tools, and the supplied capability that replaced it. */
const REPLACEMENTS = `replacements (tool, capability_id, name, description) AS (VALUES
  ('workflows', 'workflow-drafting', 'Workflow drafting',
    'Drafts workflows for a member to review and save.'),
  ('step', 'step-operations', 'Step operations',
    'Reads a workflow step, fills fields and comments on its work.'),
  ('project', 'project-operations', 'Project operations',
    'Reads a project''s tickets, starts them and fills fields.'))`;

const TOOLS_USED = `FROM agents, json_each(agents.app_tools)
  JOIN replacements ON replacements.tool = json_each.value`;

/**
 * Agents select stored capabilities instead of T45's fixed tools, and keep the ones they had.
 * Until a start imports the deployed definitions, those capabilities are stand-ins with no MCP
 * servers or files.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE capabilities (
      id TEXT PRIMARY KEY NOT NULL,
      definition TEXT NOT NULL
    )`;
  yield* sql`CREATE TABLE agent_capabilities (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL REFERENCES capabilities(id),
      PRIMARY KEY (agent_id, capability_id)
    )`;
  yield* sql.unsafe(`WITH ${REPLACEMENTS}
    INSERT INTO capabilities (id, definition)
    SELECT DISTINCT capability_id, json_object('id', capability_id,
      'name', replacements.name, 'description', replacements.description)
    ${TOOLS_USED}`);
  yield* sql.unsafe(`WITH ${REPLACEMENTS}
    INSERT INTO agent_capabilities (agent_id, capability_id)
    SELECT DISTINCT agents.id, capability_id
    ${TOOLS_USED}`);
  yield* sql`ALTER TABLE agents DROP COLUMN app_tools`;
});
