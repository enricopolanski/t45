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

const programs = [
  { name: "workflow-tools", definition: workflowDrafting },
  { name: "step-tools", definition: stepOperations },
  { name: "project-tools", definition: projectOperations },
];
const encodeCapabilities = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Capability)));
const encodeBuiltIns = Schema.encodeSync(Schema.fromJsonString(BuiltIns));

for (const [index, { name }] of programs.entries()) {
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

const capabilities = [
  ...(await Promise.all(
    programs.map(async ({ name, definition }) =>
      Capability.make({
        ...definition,
        files: { [`${name}.mjs`]: await NodeFSP.readFile(`dist/runtime/${name}.mjs`, "utf8") },
      }),
    ),
  )),
  webBrowser,
];

await NodeFSP.writeFile("dist/capabilities.json", `${encodeCapabilities(capabilities)}\n`);
await NodeFSP.writeFile("dist/built-ins.json", `${encodeBuiltIns({ capabilities, agents })}\n`);
