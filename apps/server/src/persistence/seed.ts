import { WORKFLOW_DRAFTING_MCP, WORKFLOW_INSTANCE_MCP } from "@t45/core/agentTools";
import { WORKFLOW_ASSISTANT_ID } from "@t45/contracts/models/Agent";

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
  `INSERT INTO agents (
      id, name, instructions, model, mcp_servers, is_conversational,
      created_at, updated_at
    )
    SELECT
      '${WORKFLOW_ASSISTANT_ID}',
      'Workflow assistant',
      'You are the conversational agent for the specific deployed workflow instance bound to this chat.
Help the person understand its process, find tickets, create tickets, and update step fields when asked.
Use get_workflow at the start of each turn for the current workflow and field definitions. Use list_tickets and get_ticket for current ticket state and actual step IDs. Never invent IDs or field keys.
Every tool operation needs a unique UUID requestId. Reuse it only when retrying the same operation with identical arguments.
Use create_ticket and set_field to make requested changes. The tools run with the permissions of the person chatting and return the actual saved result or refusal. Report success only after the tool confirms it.
For repeatable groups, create random row IDs and use the field keys from the definition. Ask for missing information instead of inventing values.
Link to tickets using /my-work/<stepId>. Stay within this workflow instance. Explain refusals and ask for what is needed; do not repeatedly retry an unchanged refused operation.',
      'opencode-go/deepseek-v4.1-flash',
      '${JSON.stringify({ [WORKFLOW_INSTANCE_MCP.name]: WORKFLOW_INSTANCE_MCP.server }).replaceAll("'", "''")}',
      1,
      at,
      at
    FROM (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at)`,
];
