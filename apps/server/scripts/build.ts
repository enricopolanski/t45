#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Refuse a server build without a web entry point. */
class WebClientBundleMissingError extends Schema.TaggedError<WebClientBundleMissingError>()(
  "WebClientBundleMissingError",
  { webDistPath: Schema.String },
) {
  override get message(): string {
    return `Web client dist is missing at ${this.webDistPath}. Build apps/web before packaging the server.`;
  }
}

export const packageWebClient = Effect.fnUntraced(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const webDist = path.join(serverDir, "../web/dist");

  if (!(yield* fs.exists(path.join(webDist, "index.html")))) {
    return yield* new WebClientBundleMissingError({ webDistPath: webDist });
  }

  const clientDist = path.join(serverDir, "dist/client");
  yield* fs.remove(clientDist, { recursive: true, force: true });
  yield* fs.copy(webDist, clientDist);
  yield* Effect.log("[build] Bundled web app into dist/client");
});

if (import.meta.main) {
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* packageWebClient(yield* path.fromFileUrl(new URL("..", import.meta.url)));
  }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
