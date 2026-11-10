import type { ChatId } from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/** One successful command: who ran it, on whose authority, and what it acted on. */
export interface CommandLogEntry {
  /** The command's RPC name. */
  readonly command: string;
  /** The user on whose authority the command ran. */
  readonly userId: string | null;
  /** The agent whose execution ran it; null when the user ran it themselves. */
  readonly agentId: string | null;
  readonly chatId: ChatId | null;
  readonly workflowId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly stepId?: string | undefined;
  /** Ids and keys the command was given or made; never field values or free text. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: DateTime.Utc;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    /** Appends inside the caller's transaction, so the entry commits with the change it records. */
    append: (entry: CommandLogEntry) =>
      sql`INSERT INTO command_log (command, user_id, agent_id, chat_id, workflow_id, project_id,
            ticket_id, step_id, details, created_at)
          VALUES (${entry.command}, ${entry.userId}, ${entry.agentId}, ${entry.chatId},
            ${entry.workflowId ?? null}, ${entry.projectId ?? null}, ${entry.ticketId ?? null},
            ${entry.stepId ?? null}, ${JSON.stringify(entry.details)},
            ${DateTime.formatIso(entry.createdAt)})`.pipe(Effect.asVoid, Effect.orDie),
  };
});

export class CommandLogRepository extends Context.Service<
  CommandLogRepository,
  Effect.Success<typeof make>
>()("t45/persistence/CommandLogRepository") {}
export const layer = Layer.effect(CommandLogRepository, make);
