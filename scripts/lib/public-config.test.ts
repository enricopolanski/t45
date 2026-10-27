// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "CLERK_PUBLISHABLE_KEY=pk_root\nCLERK_JWT_TEMPLATE=template_root\nCLERK_CLI_OAUTH_CLIENT_ID=oauth_root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_local\nCLERK_JWT_TEMPLATE=template_local\nCLERK_CLI_OAUTH_CLIENT_ID=oauth_local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).CLERK_PUBLISHABLE_KEY).toBe("pk_local");
    expect(
      loadRepoEnv({
        baseEnv: {
          CLERK_PUBLISHABLE_KEY: "pk_ci",
          CLERK_JWT_TEMPLATE: "template_ci",
          CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
        },
        repoRoot,
      }),
    ).toMatchObject({
      CLERK_PUBLISHABLE_KEY: "pk_ci",
      CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
