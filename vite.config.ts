import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import * as NodeURL from "node:url";

import baseConfig from "./vite.base.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    staged: { "*": "vp check --fix" },
    run: {
      cache: true,
      tasks: {
        "pre-commit": {
          command: "vp check --fix && vp run typecheck && vp run knip && vp run test",
          cache: false,
        },
        test: {
          command: "vp run -r test",
          cache: false,
        },
        browser: { command: "node scripts/browser.ts", cache: false },
        dev: {
          command: "node --env-file-if-exists=.env scripts/dev.ts",
          dependsOn: ["@t45/capabilities#build"],
          cache: false,
        },
        "sync:repos": { command: "node scripts/sync-reference-repos.ts", cache: false },
      },
    },
    test: {
      projects: [
        {
          extends: true,
          test: { name: "root", maxWorkers: "100%", exclude: ["apps/web/**"] },
        },
        NodeURL.fileURLToPath(new URL("./apps/web/vite.config.ts", import.meta.url)),
      ],
    },
  }),
);
