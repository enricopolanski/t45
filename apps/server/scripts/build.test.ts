import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { packageWebClient } from "./build.ts";

const makeFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "server packaging " });
  const server = path.join(root, "apps/server");
  const client = path.join(root, "apps/web/dist");
  const dist = path.join(server, "dist");
  yield* fs.makeDirectory(path.join(client, "assets"), { recursive: true });
  yield* fs.makeDirectory(path.join(dist, "client/assets"), { recursive: true });
  yield* fs.writeFileString(path.join(client, "index.html"), "<html>new client</html>");
  yield* fs.writeFileString(path.join(client, "assets/client.js"), "console.log('client');");
  yield* fs.writeFileString(path.join(dist, "bin.mjs"), "existing server");
  yield* fs.writeFileString(path.join(dist, "bin.mjs.map"), "existing source map");
  yield* fs.writeFileString(path.join(dist, "client/index.html"), "<html>old client</html>");
  yield* fs.writeFileString(path.join(dist, "client/assets/old.js"), "old client");
  return { fs, path, server, client, dist };
});

it.layer(NodeServices.layer)("server packaging", (it) => {
  it.effect("replaces the complete web client while preserving the server bundle", () =>
    Effect.gen(function* () {
      const { fs, path, server, dist } = yield* makeFixture();

      yield* packageWebClient(server);

      assert.strictEqual(yield* fs.readFileString(path.join(dist, "bin.mjs")), "existing server");
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "bin.mjs.map")),
        "existing source map",
      );
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
      const { fs, path, server, client, dist } = yield* makeFixture();
      yield* fs.remove(path.join(client, "index.html"));

      const error = yield* Effect.flip(packageWebClient(server));

      assert.strictEqual(error._tag, "WebClientBundleMissingError");
      assert.strictEqual(yield* fs.readFileString(path.join(dist, "bin.mjs")), "existing server");
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "bin.mjs.map")),
        "existing source map",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "client/index.html")),
        "<html>old client</html>",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(dist, "client/assets/old.js")),
        "old client",
      );
    }),
  );
});
