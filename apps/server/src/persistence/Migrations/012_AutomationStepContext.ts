import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE automations ADD COLUMN step_context TEXT NOT NULL DEFAULT 'included'
    CHECK (step_context IN ('included', 'on_demand'))`;
});
