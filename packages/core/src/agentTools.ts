import {
  WORKFLOW_DRAFTING_MCP_NAME,
  STEP_TOOLS_MCP_NAME,
  T45_TOOLS_DIR,
  type Agent,
} from "@t45/contracts/models/Agent";

/**
 * The MCP server a chat agent drafts workflows with: an injected tool, which admins add to
 * the agents that should draft. Outside Code Mode, each draft is a call the chat shows as a card,
 * and only under this name.
 */
export const WORKFLOW_DRAFTING_MCP = {
  name: WORKFLOW_DRAFTING_MCP_NAME,
  server: {
    type: "local",
    command: ["node", `${T45_TOOLS_DIR}/workflow-tools.mjs`],
    codemode: false,
  },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };

export const STEP_TOOLS_MCP = {
  name: STEP_TOOLS_MCP_NAME,
  server: { type: "local", command: ["node", `${T45_TOOLS_DIR}/step-tools.mjs`], codemode: false },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };
