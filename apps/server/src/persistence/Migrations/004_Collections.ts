import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const statements = [
  `CREATE TABLE collections (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      fields TEXT NOT NULL,
      primary_key_field_id TEXT NOT NULL,
      member_user_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE collection_records (
      collection_id TEXT NOT NULL REFERENCES collections(id),
      key TEXT NOT NULL,
      field_values TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, key)
    ) WITHOUT ROWID`,
  `ALTER TABLE attachments ADD COLUMN collection_id TEXT REFERENCES collections(id)`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});
