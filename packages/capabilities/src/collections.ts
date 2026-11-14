import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";
import { COLLECTIONS_CAPABILITY_ID } from "@t45/contracts/resources/AgentTools";

export const collections = Capability.make({
  id: COLLECTIONS_CAPABILITY_ID,
  name: "Collections",
  description: "Creates collections, and looks up, adds and updates their records.",
  mcpServers: {
    collections: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/collection-tools.mjs`],
      codemode: false,
      environment: {
        T45_SERVER_URL: "{{serverUrl}}",
        T45_TOOL_TOKEN: "{{token}}",
        T45_TOOL_INSTANCE: "{{instanceId}}",
      },
    },
  },
  note: "Collections keep data that people and agents reuse across tasks. Look a record up by its primary key before collecting the same information again, and save what you collected afterwards: saving a record with an existing key replaces that record whole.",
});
