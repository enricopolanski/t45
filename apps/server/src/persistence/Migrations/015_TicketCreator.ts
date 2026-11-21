import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE tickets ADD COLUMN creator_user_id TEXT`;
  // Whoever the command log names as starting the ticket.
  yield* sql`UPDATE tickets SET creator_user_id = (
      SELECT log.user_id FROM command_log AS log
      WHERE log.command = 'workflows.startTicket' AND log.ticket_id = tickets.id
      ORDER BY log.created_at LIMIT 1)`;
});
