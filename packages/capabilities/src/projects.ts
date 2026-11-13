import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";

export const projectOperations = Capability.make({
  id: "project-operations",
  name: "Project operations",
  description: "Reads a project's tickets, starts them and fills fields.",
  requiredContext: ["projectId"],
  mcpServers: {
    project: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/project-tools.mjs`],
      codemode: false,
      environment: {
        T45_SERVER_URL: "{{serverUrl}}",
        T45_TOOL_TOKEN: "{{token}}",
        T45_TOOL_INSTANCE: "{{instanceId}}",
        T45_PROJECT_ID: "{{projectId}}",
      },
    },
  },
});
