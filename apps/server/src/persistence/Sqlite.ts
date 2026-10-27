import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { setupSchema } from "./Schema.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// The client already waits out other writers for 5s and runs in WAL mode; these
// are the connection settings it leaves to us.
const configure = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON;`;
  // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
  // largest size until the last connection closes.
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
});

const configureAndSetup = Effect.andThen(configure, setupSchema());

export const layerFromPath = Effect.fnUntraced(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    Layer.effectDiscard(configureAndSetup),
    SqliteClient.layer({ filename: dbPath }),
  );
}, Layer.unwrap);

const layerNodeFileSystem = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

// Tests open about a thousand databases per run, and creating the schema in each
// one dominated their setup. The schema is identical every time, so it is created
// once per process and every test database starts as a copy of it, fingerprint
// included.
const schemaImage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-sqlite-template-",
  });
  const filename = path.join(dir, "template.sqlite");
  // Closing the client checkpoints the WAL into the file, so it is complete
  // once the setup's layer is released.
  yield* configureAndSetup.pipe(Effect.provide(SqliteClient.layer({ filename })));
  return yield* fs.readFile(filename);
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(layerNodeFileSystem, NodeCrypto.layer)),
  Effect.cached,
  Effect.runSync,
);

/** A fresh database per build, copied from a schema created once per process. */
export const layerTest = Layer.unwrap(
  Effect.gen(function* () {
    const image = yield* schemaImage;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-sqlite-test-",
    });
    const filename = path.join(dir, "state.sqlite");
    yield* fs.writeFile(filename, image);
    return Layer.provideMerge(Layer.effectDiscard(configure), SqliteClient.layer({ filename }));
  }),
).pipe(Layer.provide(layerNodeFileSystem));

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    return layerFromPath(dbPath);
  }),
);
