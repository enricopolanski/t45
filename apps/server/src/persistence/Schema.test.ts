import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { setupSchema } from "./Schema.ts";

const memoryDatabase = () =>
  Layer.merge(SqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer);

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

it.effect("creates the schema on an empty database and accepts it on the next start", () =>
  Effect.gen(function* () {
    yield* setupSchema();
    const created = yield* tableNames;
    assert.include(created, "agents");
    assert.include(created, "attachments");
    assert.include(created, "chat_attachments");
    assert.include(created, "schema_fingerprint");
    yield* setupSchema();
    assert.deepStrictEqual(yield* tableNames, created);
  }).pipe(Effect.provide(memoryDatabase())),
);

it.effect("refuses a database created by a different schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* setupSchema();
    yield* sql`UPDATE schema_fingerprint SET fingerprint = 'other'`;
    const refused = yield* Effect.flip(setupSchema());
    assert.strictEqual(refused._tag, "SchemaMismatchError");
    assert.include(refused.message, "move it aside to start fresh");
  }).pipe(Effect.provide(memoryDatabase())),
);

it.effect("refuses a database with tables but no fingerprint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE chats (id TEXT PRIMARY KEY)`;
    const refused = yield* Effect.flip(setupSchema());
    assert.strictEqual(refused._tag, "SchemaMismatchError");
    assert.deepStrictEqual(yield* tableNames, ["chats"]);
  }).pipe(Effect.provide(memoryDatabase())),
);
