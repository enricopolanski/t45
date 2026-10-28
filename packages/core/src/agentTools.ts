import {
  WORKFLOW_DRAFTING_MCP_NAME,
  STEP_TOOLS_MCP_NAME,
  WORKFLOW_INSTANCE_MCP_NAME,
  type Agent,
} from "@t45/contracts/models/Agent";

/**
 * The MCP server a chat agent drafts workflows with: the image's drafting tool, which admins add to
 * the agents that should draft. Outside Code Mode, each draft is a call the chat shows as a card,
 * and only under this name.
 */
export const WORKFLOW_DRAFTING_MCP = {
  name: WORKFLOW_DRAFTING_MCP_NAME,
  server: { type: "local", command: ["node", "/opt/t45/workflow-tools.mjs"], codemode: false },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };

export const STEP_TOOLS_MCP = {
  name: STEP_TOOLS_MCP_NAME,
  server: { type: "local", command: ["node", "/opt/t45/step-tools.mjs"], codemode: false },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };

export const WORKFLOW_INSTANCE_MCP = {
  name: WORKFLOW_INSTANCE_MCP_NAME,
  server: {
    type: "local",
    command: ["node", "/opt/t45/workflow-instance-tools.mjs"],
    codemode: false,
  },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };
