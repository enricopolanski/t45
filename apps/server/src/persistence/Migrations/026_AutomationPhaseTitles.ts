import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The next phases keep their titles in next_phases.
  yield* sql`ALTER TABLE automations ADD COLUMN first_phase_title TEXT`;
});
