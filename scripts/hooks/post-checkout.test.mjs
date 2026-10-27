import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { assert, it, onTestFinished } from "vite-plus/test";

const hook = NodeURL.fileURLToPath(new URL("../../.githooks/post-checkout", import.meta.url));

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "post-checkout test "));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const write = (file, content = "fixture") => {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
    return target;
  };
  // Only the root lookup is simulated; the checked-in hook does the actual cleanup.
  NodeFS.chmodSync(
    write(
      "bin/git",
      '#!/bin/sh\n[ "$*" = "rev-parse --show-toplevel" ] || exit 97\nprintf "%s\\n" "$T45_HOOK_TEST_ROOT"\n',
    ),
    0o755,
  );
  NodeFS.chmodSync(
    write(
      "bin/pnpm",
      '#!/bin/sh\nprintf "%s|%s|%s\\n" "$PWD" "$CI" "$*" >> "$T45_HOOK_TEST_INSTALLS"\nexit "$T45_HOOK_TEST_INSTALL_STATUS"\n',
    ),
    0o755,
  );
  write("package.json", "{}");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  const installs = NodePath.join(root, "installs");
  return {
    root,
    write,
    exists: (file) => NodeFS.existsSync(NodePath.join(root, file)),
    installs: () =>
      NodeFS.existsSync(installs) ? NodeFS.readFileSync(installs, "utf8").trim().split("\n") : [],
    run: (args = ["HEAD", "HEAD", "1"], env = {}) => {
      const result = NodeChildProcess.spawnSync("sh", [hook, ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...NodeProcess.env,
          PATH: `${NodePath.join(root, "bin")}:${NodeProcess.env.PATH}`,
          T45_HOOK_TEST_ROOT: root,
          T45_HOOK_TEST_INSTALLS: installs,
          T45_HOOK_TEST_INSTALL_STATUS: "0",
          ...env,
        },
      });
      assert.isUndefined(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    },
  };
}

it("removes all app and package builds", () => {
  const work = fixture();
  work.write("apps/server/dist/client/index.html", "<html>built spa</html>");
  work.write("apps/server/dist/index.mjs");
  work.write("apps/web/dist/index.html");
  work.write("apps/runner/dist/index.mjs");
  work.write("packages/contracts/dist/index.d.ts");

  work.run();

  assert.isFalse(work.exists("apps/server/dist"));
  assert.isFalse(work.exists("apps/web/dist"));
  assert.isFalse(work.exists("apps/runner/dist"));
  assert.isFalse(work.exists("packages/contracts/dist"));
});

it("clears nested TypeScript build info while preserving dependencies and internal caches", () => {
  const work = fixture();
  work.write("tsconfig.tsbuildinfo");
  work.write("apps/web/nested/tsconfig.tsbuildinfo");
  const preserved = [
    "node_modules/dependency/tsconfig.tsbuildinfo",
    "apps/web/node_modules/dependency/tsconfig.tsbuildinfo",
    ".git/tsconfig.tsbuildinfo",
    ".vite-plus/tsconfig.tsbuildinfo",
  ];
  for (const file of preserved) work.write(file);

  work.run();

  assert.isFalse(work.exists("tsconfig.tsbuildinfo"));
  assert.isFalse(work.exists("apps/web/nested/tsconfig.tsbuildinfo"));
  for (const file of preserved) assert.isTrue(work.exists(file), file);
});

it.each([{ args: [] }, { args: ["HEAD", "HEAD", "0"] }])(
  "leaves file checkouts alone: %j",
  ({ args }) => {
    const work = fixture();
    work.write("apps/web/dist/index.html");
    work.write("tsconfig.tsbuildinfo");

    const result = work.run(args);

    assert.equal(result.stdout + result.stderr, "");
    assert.isTrue(work.exists("apps/web/dist/index.html"));
    assert.isTrue(work.exists("tsconfig.tsbuildinfo"));
    assert.isEmpty(work.installs());
  },
);

it("invokes the caller's pnpm on every branch checkout, even with installed dependencies", () => {
  const work = fixture();
  work.write("node_modules/.modules.yaml", "{}");

  work.run();
  work.run();

  assert.deepStrictEqual(work.installs(), [
    `${work.root}|1|install --frozen-lockfile --prefer-offline --config.package-import-method=hardlink --config.confirmModulesPurge=false`,
    `${work.root}|1|install --frozen-lockfile --prefer-offline --config.package-import-method=hardlink --config.confirmModulesPurge=false`,
  ]);
});

it("reports an install failure without failing the checkout", () => {
  const work = fixture();

  const result = work.run(undefined, { T45_HOOK_TEST_INSTALL_STATUS: "23" });

  assert.include(result.stderr, "dependency preparation failed (exit 23)");
  assert.lengthOf(work.installs(), 1);
});

it.each(["package.json", "pnpm-lock.yaml"])("skips installing without %s", (file) => {
  const work = fixture();
  NodeFS.rmSync(NodePath.join(work.root, file));
  work.write("apps/web/dist/index.html");

  work.run();

  assert.isFalse(work.exists("apps/web/dist"));
  assert.isEmpty(work.installs());
});
