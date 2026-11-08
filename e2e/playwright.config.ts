// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { defineConfig } from "@playwright/test";

const home = NodePath.join(NodeOS.tmpdir(), "t45-e2e");

export default defineConfig({
  testDir: "./tests",
  // Uses the running dev app; with none, starts one on a fresh throwaway home and stops it after.
  webServer: {
    command: `rm -rf "${home}" && vp run dev --home-dir "${home}"`,
    cwd: "..",
    url: "http://localhost:5733/api/auth/session",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://localhost:5733",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
