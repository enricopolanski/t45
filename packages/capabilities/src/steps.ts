import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";

export const stepOperations = Capability.make({
  id: "step-operations",
  name: "Step operations",
  description: "Reads a workflow step, fills fields and comments on its work.",
  requiredContext: ["stepId"],
  mcpServers: {
    step: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/step-tools.mjs`],
      codemode: false,
      environment: {
        T45_SERVER_URL: "{{serverUrl}}",
        T45_TOOL_TOKEN: "{{token}}",
        T45_TOOL_INSTANCE: "{{instanceId}}",
        T45_STEP_ID: "{{stepId}}",
      },
    },
  },
});
