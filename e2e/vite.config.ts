import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // E2E's dev build cleans the runtime files consumed by the server tests.
      test: { command: "playwright test", dependsOn: ["t45#test"], cache: false },
    },
  },
});
