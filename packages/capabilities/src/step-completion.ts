import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";
import { STEP_COMPLETION_CAPABILITY_ID } from "@t45/contracts/resources/AgentTools";

export const stepCompletion = Capability.make({
  id: STEP_COMPLETION_CAPABILITY_ID,
  name: "Step completion",
  description: "Finishes the current step and advances the ticket.",
  requiredContext: ["stepId"],
  mcpServers: {
    step_completion: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/step-completion-tools.mjs`],
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
