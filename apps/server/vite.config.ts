import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import * as NodeURL from "node:url";

import baseConfig from "../../vite.base.config.ts";

const serverTestTimeout = 5_000;

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        dev: {
          command: 'vp pack --watch --on-success "node dist/bin.mjs"',
          cache: false,
        },
        "build:bundle": {
          command: "vp pack",
          cache: {
            env: ["BUILD_SHA"],
            output: ["dist/bin.mjs", "dist/bin.mjs.map", "dist/runtime/**"],
          },
        },
        test: { command: "vp test run", dependsOn: ["build:bundle"] },
        build: {
          command: "node scripts/build.ts",
          dependsOn: ["build:bundle", "@t45/web#build"],
          cache: { output: ["dist/client/**"] },
        },
      },
    },
    pack: {
      entry: {
        bin: "src/bin.ts",
        "runtime/step-tools": NodeURL.fileURLToPath(
          new URL("./src/agent-tools/step-tools.ts", import.meta.url),
        ),
        "runtime/workflow-instance-tools": NodeURL.fileURLToPath(
          new URL("./src/agent-tools/workflow-instance-tools.ts", import.meta.url),
        ),
        "runtime/workflow-tools": NodeURL.fileURLToPath(
          new URL("./src/agent-tools/workflow-tools.ts", import.meta.url),
        ),
      },
      // Inject the tool entry points and modules they share with the server together.
      outputOptions: { chunkFileNames: "runtime/[name]-[hash].mjs" },
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: (id: string) => !id.startsWith("node:"),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: process.env.BUILD_SHA
        ? { "process.env.BUILD_SHA": JSON.stringify(process.env.BUILD_SHA) }
        : {},
    },
    test: {
      maxWorkers: "100%",
      name: "server",
      include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
      hookTimeout: serverTestTimeout,
      testTimeout: serverTestTimeout,
    },
  }),
);
