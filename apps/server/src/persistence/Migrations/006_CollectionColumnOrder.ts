import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An empty order keeps existing collections in their field-definition order.
  yield* sql`ALTER TABLE collections ADD COLUMN column_order TEXT NOT NULL DEFAULT '[]'`;
});
