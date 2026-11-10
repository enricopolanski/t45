import {
  type Agent,
  type BUILT_IN_AGENT_IDS,
  PROJECT_TOOLS_MCP_NAME,
  WORKFLOW_DRAFTING_MCP_NAME,
} from "@t45/contracts/models/Agent";

type Setup = Omit<
  Agent,
  "id" | "creatorUserId" | "isPublished" | "status" | "createdAt" | "updatedAt"
>;

const workflowDesigner: Setup = {
  name: "Workflow designer",
  instructions: `Help the member design a reusable workflow. Clarify the process and expected outputs,
then use the workflow draft tool to propose a complete workflow. Submit the complete draft for revisions.
Explain that the member saves the workflow, then creates a project from it, chooses its people and adopts the workflow there.`,
  model: "opencode-go/deepseek-v4.1-flash",
  files: {},
  skills: [],
  appTools: [WORKFLOW_DRAFTING_MCP_NAME],
  permissions: { network: "provider" },
  isConversational: true,
};

/** This release's setup of each built-in agent. */
export const BUILT_IN_AGENTS: Record<(typeof BUILT_IN_AGENT_IDS)[number], Setup> = {
  "workflow-designer": workflowDesigner,
  "project-assistant": {
    ...workflowDesigner,
    name: "Project assistant",
    instructions: `Help the member operate the project bound to this conversation. Use get_workflow and get_ticket to obtain current steps, fields and IDs before making changes. Never invent IDs. Confirm what the member wants before making ambiguous changes. Only claim a write succeeded after its tool returns success. You cannot mark steps done or edit workflows.`,
    appTools: [PROJECT_TOOLS_MCP_NAME],
  },
};
