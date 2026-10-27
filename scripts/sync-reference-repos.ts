#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parse as parseYaml } from "yaml";

const WorkspaceVersions = Schema.Struct({
  catalog: Schema.Struct({
    effect: Schema.NonEmptyString,
    "@opencode/client": Schema.NonEmptyString,
  }),
});

class ReferenceRepoGitError extends Schema.TaggedError<ReferenceRepoGitError>()(
  "ReferenceRepoGitError",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message(): string {
    return `${this.command} failed (exit ${this.exitCode}).`;
  }
}

export const syncReferenceRepos = Effect.fnUntraced(function* (
  options: { repoId?: "effect" | "opencode" | undefined; dryRun?: boolean | undefined } = {},
  root = `${import.meta.dirname}/..`,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rootDir = path.resolve(root);
  const source = yield* fs.readFileString(path.join(rootDir, "pnpm-workspace.yaml"));
  const { catalog } = yield* Effect.try((): unknown => parseYaml(source)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceVersions)),
  );
  const repos = [
    { id: "effect", ref: `effect@${catalog.effect}` },
    { id: "opencode", ref: `v${catalog["@opencode/client"]}` },
  ];

  for (const repo of repos) {
    if (options.repoId !== undefined && options.repoId !== repo.id) continue;
    const prefix = `.repos/${repo.id}`;
    yield* Console.log(`${options.dryRun ? "Would sync" : "Syncing"} ${repo.id} to ${repo.ref}.`);
    for (const args of [
      ["submodule", "update", "--init", "--depth", "1", "--", prefix],
      ["-C", prefix, "fetch", "--depth", "1", "--no-tags", "origin", "tag", repo.ref],
      ["-C", prefix, "checkout", "--quiet", "--detach", repo.ref],
    ]) {
      const command = `git ${args.join(" ")}`;
      yield* Console.log(command);
      if (options.dryRun) continue;
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make("git", args, {
          cwd: rootDir,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      if (exitCode !== 0) return yield* new ReferenceRepoGitError({ command, exitCode });
    }
  }
});

const command = Command.make(
  "sync-reference-repos",
  {
    repo: Flag.Literals("repo", ["effect", "opencode"]).pipe(
      Flag.withDescription("Sync only this reference repo; defaults to both."),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the Git commands without running them."),
      Flag.withDefault(false),
    ),
  },
  ({ repo, dryRun }) => syncReferenceRepos({ repoId: Option.getOrUndefined(repo), dryRun }),
).pipe(Command.withDescription("Sync reference submodules to the workspace catalog versions."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
