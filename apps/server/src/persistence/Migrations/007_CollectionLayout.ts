import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An empty layout keeps existing collections shown as before.
  yield* sql`ALTER TABLE collections ADD COLUMN layout TEXT NOT NULL DEFAULT '{}'`;
});
