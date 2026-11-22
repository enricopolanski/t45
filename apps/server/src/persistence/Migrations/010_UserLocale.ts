import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE users ADD COLUMN locale TEXT CHECK (locale IN ('en', 'de', 'it'))`;
});
