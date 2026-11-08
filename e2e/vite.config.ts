import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      test: { command: "playwright test", cache: false },
    },
  },
});
