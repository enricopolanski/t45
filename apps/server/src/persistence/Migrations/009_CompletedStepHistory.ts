import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projects ADD COLUMN step_history_access TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`CREATE TABLE completed_steps (
    step_id TEXT PRIMARY KEY NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE completed_step_files (
    step_id TEXT NOT NULL REFERENCES completed_steps(step_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (attachment_id, step_id)
  ) WITHOUT ROWID`;
});
