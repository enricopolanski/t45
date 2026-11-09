import {
  WORKFLOW_DRAFTING_MCP_NAME,
  WORKFLOW_INSTANCE_MCP_NAME,
  STEP_TOOLS_MCP_NAME,
  T45_TOOLS_DIR,
  type Agent,
} from "@t45/contracts/models/Agent";

/**
 * Keep these tools individually visible in the conversation; draft tool parts render blueprint cards.
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

export const WORKFLOW_INSTANCE_MCP = {
  name: WORKFLOW_INSTANCE_MCP_NAME,
  server: {
    type: "local",
    command: ["node", `${T45_TOOLS_DIR}/workflow-instance-tools.mjs`],
    codemode: false,
  },
} as const satisfies { readonly name: string; readonly server: Agent["mcpServers"][string] };
