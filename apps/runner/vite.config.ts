import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["image/workflow-tools.mjs", "image/workflow-instance-tools.mjs"],
    outDir: "dist/image",
    clean: true,
    deps: {
      alwaysBundle: (id: string) => !id.startsWith("node:"),
      onlyBundle: false,
    },
  },
});
