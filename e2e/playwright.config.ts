import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://localhost:5733",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
