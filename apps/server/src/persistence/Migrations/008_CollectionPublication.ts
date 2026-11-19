import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE collections ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0
    CHECK (is_published IN (0, 1))`;
});
