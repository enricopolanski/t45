import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import * as NodeURL from "node:url";

import baseConfig from "./vite.base.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      cache: true,
      tasks: {
        dev: { command: "node scripts/dev.ts", cache: false },
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
