import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workflow_attachments (
    attachment_id TEXT PRIMARY KEY NOT NULL REFERENCES attachments(id),
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
});
