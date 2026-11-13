import type { BuiltIns } from "@t45/contracts/resources/BuiltIns";
import { workflowDrafting } from "./workflows.ts";
import { projectOperations } from "./projects.ts";
import { webBrowser } from "./browser.ts";

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
  {
    ...workflowDesigner,
    id: "web-researcher",
    name: "Web researcher",
    instructions: `Find what the member asks for on websites, using the web browser. Read the pages that answer it and reply with what you found, citing each page's URL. Say when a page doesn't show something rather than guessing it. Don't sign in, buy or submit forms unless the member asks for it in this conversation.`,
    capabilities: [webBrowser.id],
  },
];
