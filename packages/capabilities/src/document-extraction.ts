import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";

const stepEnvironment = {
  T45_SERVER_URL: "{{serverUrl}}",
  T45_TOOL_TOKEN: "{{token}}",
  T45_TOOL_INSTANCE: "{{instanceId}}",
  T45_STEP_ID: "{{stepId}}",
};

export const documentExtraction = Capability.make({
  id: "document-extraction",
  name: "Document extraction",
  description:
    "Reads the text and images of the attached PDFs and saves extracted records to the step in one batch.",
  requiredContext: ["stepId"],
  environment: {
    ...stepEnvironment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugins: [`file://${CAPABILITIES_DIR}/document-extraction`],
    }),
  },
  mcpServers: {
    extraction: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/extraction-tools.mjs`],
      codemode: false,
      environment: stepEnvironment,
    },
  },
});
