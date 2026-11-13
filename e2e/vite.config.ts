import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // A dev launch may restore the capability build; finish tests that read those assets first.
      test: { command: "playwright test", dependsOn: ["@t45/capabilities#test"], cache: false },
    },
  },
});
