import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A single second phase becomes the first of a list.
  yield* sql`ALTER TABLE automations RENAME COLUMN follow_up TO next_phases`;
  yield* sql`UPDATE automations SET next_phases = json_array(json(next_phases))
    WHERE next_phases IS NOT NULL`;
});
