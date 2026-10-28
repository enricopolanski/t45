import { WORKFLOW_DRAFTING_MCP } from "@t45/core/agentTools";

/** Starter agents, inserted only when the database is created so admins keep their edits. */
export const seedStatements = [
  `INSERT INTO agents (
      id, name, instructions, model, mcp_servers, is_conversational,
      created_at, updated_at
    )
    SELECT
      'workflow-designer',
      'Workflow designer',
      'Help people design reusable workflow blueprints.
Ask concise questions to clarify the process, its steps, and the information needed.
Use the workflow drafting tool to present drafts and submit the complete draft again for revisions.
The person saves the blueprint, then separately configures and publishes a workflow. Do not claim those actions have already happened.',
      'opencode-go/deepseek-v4.1-flash',
      '${JSON.stringify({
        [WORKFLOW_DRAFTING_MCP.name]: WORKFLOW_DRAFTING_MCP.server,
      }).replaceAll("'", "''")}',
      1,
      at,
      at
    FROM (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at)`,
];
