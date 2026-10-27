import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { buildServer } from "./build.ts";

const encodePackage = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      private: Schema.Literal(true),
      type: Schema.Literal("module"),
      scripts: Schema.Struct({ "build:bundle": Schema.String }),
    }),
  ),
);
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const fixture = Effect.fnUntraced(function* (bundleScript = "vp pack") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "server build " });
  const server = path.join(root, "apps/server");
  const client = path.join(root, "apps/web/dist");
  yield* fs.makeDirectory(path.join(server, "src"), { recursive: true });
  yield* fs.makeDirectory(path.join(client, "assets"), { recursive: true });
  yield* fs.writeFileString(path.join(client, "index.html"), "<html>new client</html>");
  yield* fs.writeFileString(path.join(client, "assets/client.js"), "console.log('client');");
  yield* fs.writeFileString(path.join(server, "src/bin.ts"), "export const ready = true;");
  yield* fs.writeFileString(
    path.join(server, "package.json"),
    encodePackage({ private: true, type: "module", scripts: { "build:bundle": bundleScript } }),
  );
  const config = yield* path.fromFileUrl(new URL("../vite.config.ts", import.meta.url));
  yield* fs.writeFileString(
    path.join(server, "vite.config.ts"),
    `export { default } from ${encodeString(config)};`,
  );
  yield* fs.symlink(
    yield* path.fromFileUrl(new URL("../node_modules", import.meta.url)),
    path.join(server, "node_modules"),
  );
  // pnpm's workspace command shims resolve executables through the root node_modules.
  yield* fs.symlink(
    yield* path.fromFileUrl(new URL("../../../node_modules", import.meta.url)),
    path.join(root, "node_modules"),
  );
  return { fs, path, server, client, dist: path.join(server, "dist") };
});

it.layer(NodeServices.layer)("server build", (it) => {
  it.effect("cleans the output and packages the complete web client with the server", () =>
    Effect.gen(function* () {
      const { fs, path, server, dist } = yield* fixture();
      yield* fs.makeDirectory(path.join(dist, "client/assets"), { recursive: true });
      yield* fs.writeFileString(path.join(dist, "old-server.mjs"), "old server");
      yield* fs.writeFileString(path.join(dist, "client/assets/old.js"), "old client");

      yield* buildServer(server);

      assert.isTrue(yield* fs.exists(path.join(dist, "bin.mjs")));
      assert.isFalse(yield* fs.exists(path.join(dist, "old-server.mjs")));
      assert.isFalse(yield* fs.exists(path.join(dist, "client/assets/old.js")));
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "client/index.html")),
        "<html>new client</html>",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "client/assets/client.js")),
        "console.log('client');",
      );
    }),
  );

  it.effect("refuses a missing client before modifying existing output", () =>
    Effect.gen(function* () {
      const { fs, path, server, client, dist } = yield* fixture();
      yield* fs.remove(path.join(client, "index.html"));
      yield* fs.makeDirectory(dist);
      yield* fs.writeFileString(path.join(dist, "bin.mjs"), "existing server");

      const error = yield* Effect.flip(buildServer(server));

      assert.strictEqual(error._tag, "WebClientBundleMissingError");
      assert.strictEqual(yield* fs.readFileString(path.join(dist, "bin.mjs")), "existing server");
    }),
  );

  it.effect("reports packing failure without copying the client", () =>
    Effect.gen(function* () {
      const { fs, path, server, dist } = yield* fixture('node -e "process.exit(1)"');

      const error = yield* Effect.flip(buildServer(server));

      assert.strictEqual(error._tag, "BuildCommandExitError");
      assert.ok("exitCode" in error);
      assert.strictEqual(error.exitCode, 1);
      assert.isFalse(yield* fs.exists(path.join(dist, "client")));
    }),
  );
});
