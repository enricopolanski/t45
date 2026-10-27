// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

// Schema plus fingerprint: what a database set up from scratch holds.
const schemaState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql<{ readonly type: string; readonly name: string; readonly sql: string }>`
    SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  const fingerprint = yield* sql<{ readonly fingerprint: string }>`
    SELECT fingerprint FROM schema_fingerprint
  `;
  return { schema: [...schema], fingerprint: [...fingerprint] };
});

it.layer(NodeServices.layer)("SqlitePersistence", (it) => {
  it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-busy-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
        yield* spawnWriteLockHolder(dbPath, 300);
        yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
        const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
        assert.deepEqual([...rows], [{ id: 1 }]);
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
    }),
  );

  it.effect("shrinks the WAL file back to the size limit after a large write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-wal-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const walFileSize = fs.stat(`${dbPath}-wal`).pipe(Effect.map((info) => Number(info.size)));
      // About 25% more 4 KB rows than the limit holds, in one transaction.
      const rowCount = Math.ceil((SqlitePersistence.WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
          INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
        `;
        assert.isAbove(yield* walFileSize, SqlitePersistence.WAL_SIZE_LIMIT_BYTES);

        // The auto-checkpoint after the large commit copied every frame into the
        // database, so the next commit restarts the WAL and cuts the file back.
        yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
        assert.isAtMost(yield* walFileSize, SqlitePersistence.WAL_SIZE_LIMIT_BYTES);
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
    }),
  );

  it.effect("opens test databases with the same schema and fingerprint as a fresh setup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-image-" });
      const fromScratch = yield* schemaState.pipe(
        Effect.provide(SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite"))),
      );
      const fromImage = yield* schemaState.pipe(Effect.provide(SqlitePersistence.layerTest));
      assert.lengthOf(fromScratch.fingerprint, 1);
      assert.deepEqual(fromImage, fromScratch);
    }),
  );

  it.effect("gives every test database its own copy and connection pragmas", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE image_isolation_probe(id INTEGER PRIMARY KEY)`;
      }).pipe(Effect.provide(SqlitePersistence.layerTest));
      const probe = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE name = 'image_isolation_probe'
        `;
        const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
        return { tables: tables.length, foreignKeys: foreignKeys[0]?.foreign_keys };
      }).pipe(Effect.provide(SqlitePersistence.layerTest));
      assert.deepEqual(probe, { tables: 0, foreignKeys: 1 });
    }),
  );
});
