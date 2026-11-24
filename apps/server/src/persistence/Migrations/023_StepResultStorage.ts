import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS step_result_versions (
    id INTEGER PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    step_definition_id TEXT NOT NULL,
    result_key TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    snapshot TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS step_result_versions_key
    ON step_result_versions(ticket_id, step_definition_id, result_key, id DESC)`;
  yield* sql`CREATE TABLE IF NOT EXISTS step_result_inputs (
    collection_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    PRIMARY KEY(collection_id, record_key, ticket_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS step_result_inputs_ticket ON step_result_inputs(ticket_id)`;
});
