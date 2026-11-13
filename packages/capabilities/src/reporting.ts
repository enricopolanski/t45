import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";
import { REPORTING_CAPABILITY_ID } from "@t45/contracts/resources/AgentTools";

export const progressReporting = Capability.make({
  id: REPORTING_CAPABILITY_ID,
  name: "Progress reporting",
  description: "Reports what the agent is doing during its work.",
  mcpServers: {
    progress: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/report-tools.mjs`],
      codemode: false,
      environment: {
        T45_SERVER_URL: "{{serverUrl}}",
        T45_TOOL_TOKEN: "{{token}}",
        T45_TOOL_INSTANCE: "{{instanceId}}",
      },
    },
  },
  note: "Call progress_report when you start work and whenever your activity meaningfully changes. Use one brief, concrete sentence describing what you are doing, such as ‘Checking invoices against purchase orders.’ Report useful changes, not every action. These updates appear beside the run's status. Reporting does not finish the run or complete a workflow step.",
});
