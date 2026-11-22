// @effect-diagnostics nodeBuiltinImport:off - Build-time packaging reads and writes generated assets.
import * as NodeFSP from "node:fs/promises";
import { Capability } from "@t45/contracts/models/Capability";
import { BuiltIns } from "@t45/contracts/resources/BuiltIns";
import * as Schema from "effect/Schema";
import { build } from "vite-plus/pack";

import { workflowDrafting } from "../src/workflows.ts";
import { stepOperations } from "../src/steps.ts";
import { projectOperations } from "../src/projects.ts";
import { agents } from "../src/agents.ts";
import { webBrowser } from "../src/browser.ts";
import { progressReporting } from "../src/reporting.ts";
import { collections } from "../src/collections.ts";
import {
  documentExtraction,
  documentReading,
  extractionSaving,
} from "../src/document-extraction.ts";

const programs = [
  { name: "report-tools", definition: progressReporting },
  { name: "workflow-tools", definition: workflowDrafting },
  { name: "step-tools", definition: stepOperations },
  {
    name: "extraction-tools",
    definition: documentExtraction,
    plugin: "document-extraction/server.js",
  },
  // Reading and saving split an extraction in two runs, each with its own agent.
  {
    name: "extraction-tools",
    definition: documentReading,
    plugin: "document-extraction/server.js",
  },
  { name: "extraction-tools", definition: extractionSaving },
  { name: "project-tools", definition: projectOperations },
  { name: "collection-tools", definition: collections },
  { name: "browser-open", definition: webBrowser },
];
const encodeCapabilities = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Capability)));
const encodeBuiltIns = Schema.encodeSync(Schema.fromJsonString(BuiltIns));

for (const [index, name] of [...new Set(programs.map(({ name }) => name))].entries()) {
  await build({
    config: false,
    entry: { [name]: `src/${name}.ts` },
    outDir: "dist/runtime",
    clean: index === 0,
    dts: false,
    fixedExtension: true,
    outputOptions: { codeSplitting: false },
    deps: {
      alwaysBundle: (id) => !id.startsWith("node:"),
      onlyBundle: false,
    },
  });
}

const capabilities = await Promise.all(
  programs.map(async ({ name, definition, plugin }) =>
    Capability.make({
      ...definition,
      files: {
        [`${name}.mjs`]: await NodeFSP.readFile(`dist/runtime/${name}.mjs`, "utf8"),
        ...(plugin === undefined
          ? {}
          : {
              [plugin]: await NodeFSP.readFile(`src/${plugin}`, "utf8"),
              "document-extraction/package.json": '{"type":"module"}',
            }),
      },
    }),
  ),
);

await NodeFSP.writeFile("dist/capabilities.json", `${encodeCapabilities(capabilities)}\n`);
await NodeFSP.writeFile("dist/built-ins.json", `${encodeBuiltIns({ capabilities, agents })}\n`);
