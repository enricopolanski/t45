import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE attachments ADD COLUMN blob_key TEXT`;
  // Each existing attachment's bytes are the file named by its id.
  yield* sql`UPDATE attachments SET blob_key = id`;
});
