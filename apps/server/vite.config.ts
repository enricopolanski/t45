import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.base.config.ts";

const serverTestTimeout = 5_000;

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/build.ts",
          dependsOn: ["@t45/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
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
      define: {
        "process.env.BUILD_SHA": JSON.stringify(process.env.BUILD_SHA || "development"),
      },
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
