import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        // Cache the complete output together so a later restore cannot overwrite a fresh bundle.
        command: "node scripts/build.ts",
        cache: {
          input: [{ auto: true }, "!dist/**"],
          output: ["dist/runtime/**", "dist/capabilities.json", "dist/built-ins.json"],
        },
      },
      test: {
        command: "vp test run --config ../../vite.base.config.ts --dir .",
        dependsOn: ["build"],
      },
    },
  },
});
