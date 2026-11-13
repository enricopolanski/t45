import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";

export const workflowDrafting = Capability.make({
  id: "workflow-drafting",
  name: "Workflow drafting",
  description: "Drafts workflows for a member to review and save.",
  mcpServers: {
    workflows: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/workflow-tools.mjs`],
      codemode: false,
    },
  },
});
