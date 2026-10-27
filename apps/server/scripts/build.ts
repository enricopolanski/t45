#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class BuildCommandExitError extends Schema.TaggedError<BuildCommandExitError>()(
  "BuildCommandExitError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}`;
  }
}

/** Refuse a server build without a web entry point. */
class WebClientBundleMissingError extends Schema.TaggedError<WebClientBundleMissingError>()(
  "WebClientBundleMissingError",
  { webDistPath: Schema.String },
) {
  override get message(): string {
    return `Web client dist is missing at ${this.webDistPath}. Build apps/web before packaging the server.`;
  }
}

export const buildServer = Effect.fnUntraced(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const webDist = path.join(serverDir, "../web/dist");

  if (!(yield* fs.exists(path.join(webDist, "index.html")))) {
    return yield* new WebClientBundleMissingError({ webDistPath: webDist });
  }

  yield* Effect.log("[build] Packing server...");
  const pack = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
      cwd: serverDir,
      stdout: "inherit",
      stderr: "inherit",
      shell: false,
    }),
  );
  const exitCode = yield* pack.exitCode;
  if (exitCode !== 0) {
    return yield* new BuildCommandExitError({ command: "build:bundle", exitCode });
  }

  yield* fs.copy(webDist, path.join(serverDir, "dist/client"));
  yield* Effect.log("[build] Bundled web app into dist/client");
});

if (import.meta.main) {
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* buildServer(yield* path.fromFileUrl(new URL("..", import.meta.url)));
  }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
