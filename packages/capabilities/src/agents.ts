import type { BuiltIns } from "@t45/contracts/resources/BuiltIns";
import { workflowDrafting } from "./workflows.ts";
import { projectOperations } from "./projects.ts";

type Setup = (typeof BuiltIns.Type.agents)[number];

const workflowDesigner: Setup = {
  id: "workflow-designer",
  name: "Workflow designer",
  instructions: `Help the member design a reusable workflow. Clarify the process and expected outputs,
then use the workflow draft tool to propose a complete workflow. Submit the complete draft for revisions.
Explain that the member saves the workflow, then creates a project from it, chooses its people and adopts the workflow there.`,
  model: "opencode-go/deepseek-v4.1-flash",
  files: {},
  skills: [],
  capabilities: [workflowDrafting.id],
  permissions: { network: "provider" },
  isConversational: true,
};

/** This release's setup of each built-in agent. */
export const agents: ReadonlyArray<Setup> = [
  workflowDesigner,
  {
    ...workflowDesigner,
    id: "project-assistant",
    name: "Project assistant",
    instructions: `Help the member operate the project bound to this conversation. Use get_workflow and get_ticket to obtain current steps, fields and IDs before making changes. Never invent IDs. Confirm what the member wants before making ambiguous changes. Only claim a write succeeded after its tool returns success. You cannot mark steps done or edit workflows.`,
    capabilities: [projectOperations.id],
  },
];
