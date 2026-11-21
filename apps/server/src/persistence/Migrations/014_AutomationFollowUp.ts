import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE automations ADD COLUMN follow_up TEXT`;
  // An automation that ran another next takes that one's agent and prompt as its second phase.
  yield* sql`UPDATE automations SET follow_up = (
      SELECT json_object('agentId', next.agent_id, 'prompt', next.prompt)
      FROM automations AS next WHERE next.id = automations.next_automation_id)
    WHERE next_automation_id IS NOT NULL`;
  yield* sql`ALTER TABLE automations DROP COLUMN next_automation_id`;
});
