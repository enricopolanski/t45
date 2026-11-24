import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE step_result_inputs RENAME TO previous_step_result_inputs`;
  yield* sql`CREATE TABLE step_result_inputs (
    collection_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    step_definition_id TEXT NOT NULL,
    PRIMARY KEY(collection_id, record_key, ticket_id, step_definition_id)
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO step_result_inputs (collection_id, record_key, ticket_id, step_definition_id)
    SELECT collection_id, record_key, ticket_id, '' FROM previous_step_result_inputs`;
  yield* sql`DROP TABLE previous_step_result_inputs`;
  yield* sql`CREATE INDEX step_result_inputs_ticket ON step_result_inputs(ticket_id, step_definition_id)`;
});
