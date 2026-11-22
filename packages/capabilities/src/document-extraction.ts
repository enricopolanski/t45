import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";
import { EXTRACTION_SAVING_CAPABILITY_ID } from "@t45/contracts/resources/AgentTools";

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

/** The reading half of an extraction: answers with what the PDFs state, and saves nothing. */
export const documentReading = Capability.make({
  id: "document-reading",
  name: "Document reading",
  description:
    "Reads the text and images of the attached PDFs and answers with everything they state, without saving anything.",
  requiredContext: ["stepId"],
  environment: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugins: [`file://${CAPABILITIES_DIR}/document-extraction`],
    }),
    T45_DOCUMENT_MODE: "read",
  },
});

/**
 * The saving half: saves the articles another run read to the step's records field in one batch,
 * and reads the product categories and their fields.
 */
export const extractionSaving = Capability.make({
  id: EXTRACTION_SAVING_CAPABILITY_ID,
  name: "Extraction saving",
  description:
    "Saves extracted articles, with their review entries, to the step's records field in one batch, and reads product categories and their fields.",
  requiredContext: ["stepId"],
  environment: stepEnvironment,
  mcpServers: {
    extraction: {
      type: "local",
      command: ["node", `${CAPABILITIES_DIR}/extraction-tools.mjs`],
      codemode: false,
      environment: stepEnvironment,
    },
  },
});
