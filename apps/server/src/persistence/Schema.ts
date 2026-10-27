/**
 * The database schema, as the statements that create it on an empty database. Until the first
 * release, deploys start from an empty database, so a schema change edits these statements in
 * place: the fingerprint of the statements changes, and a database created by other statements is
 * refused at startup.
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// The organization's users and sessions, agents and automations, workflows, chats, and files.
const statements = [
  `CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'deactivated')),
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT 'slate',
      avatar_content_type TEXT,
      avatar_image BLOB,
      clerk_image_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  // Every session is a browser cookie from a Clerk sign-in. The cookie holds the
  // token; the row keeps only its hash. Revoking a session deletes its row.
  `CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_auth_sessions_user_id
    ON auth_sessions(user_id)`,
  `CREATE TABLE organizations (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  // The singleton organization always exists; the first admin names it on first sign-in.
  `INSERT INTO organizations (id, name, created_at, updated_at)
    SELECT 'organization', NULL, at, at
    FROM (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at)`,

  // Named agents, their skills and automations, and the workflows people and agents work
  // through.
  // Named agents are organization-wide. Every agent works in a sandbox of its own, and its model
  // is an OpenCode `provider/model` slug the runner offers. Admins choose which agents members can
  // chat with, and which of those draft workflows.
  `CREATE TABLE agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '{}',
      mcp_servers TEXT NOT NULL DEFAULT '{}',
      network TEXT NOT NULL DEFAULT 'provider' CHECK (network IN ('provider', 'open')),
      is_conversational INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE UNIQUE INDEX agents_name ON agents(name COLLATE NOCASE)`,
  `CREATE TABLE skills (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, skill_id)
    )`,
  // An Automation starts a Task with its agent: when `next_run_at`
  // comes, on Run now, or on a request to its webhook URL, whose secret is `webhook_token`.
  // `schedule_json` is the schedule, a webhook's signing secret included, and `last_error` why
  // its latest run was refused.
  `CREATE TABLE automations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      is_enabled INTEGER NOT NULL CHECK (is_enabled IN (0, 1)),
      schedule_json TEXT NOT NULL,
      webhook_token TEXT,
      next_run_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE INDEX automations_due ON automations(next_run_at)
    WHERE is_enabled = 1 AND next_run_at IS NOT NULL`,

  `CREATE TABLE workflow_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE workflows (
      id TEXT PRIMARY KEY NOT NULL,
      definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
      name TEXT NOT NULL,
      responsible_user_id TEXT NOT NULL,
      admin_user_ids TEXT NOT NULL,
      default_assignments TEXT NOT NULL,
      slug TEXT UNIQUE,
      is_default INTEGER NOT NULL,
      is_public INTEGER NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE INDEX workflows_definition ON workflows(definition_id)`,
  `CREATE TABLE tickets (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL,
      steps TEXT NOT NULL,
      current_step_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE INDEX tickets_workflow ON tickets(workflow_id, created_at)`,
  `CREATE TABLE workflow_comments (
      id TEXT PRIMARY KEY NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX workflow_comments_step ON workflow_comments(step_id, created_at)`,

  // The step tool calls T45 applied, by `<assistant message id>/<tool part id>` in the step's
  // chat; a call is applied and recorded together, so none is applied twice.
  `CREATE TABLE task_calls (
      chat_id TEXT NOT NULL REFERENCES chat_origins(chat_id),
      call_key TEXT NOT NULL,
      PRIMARY KEY (chat_id, call_key)
    ) WITHOUT ROWID`,

  // In-app notifications: something new landed in a person's My work. Opening the step reads them.
  `CREATE TABLE workflow_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('to_do', 'to_approve', 'rejected', 'agent_failed',
        'needs_responsible', 'names_deactivated')),
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      step_id TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX workflow_notifications_user ON workflow_notifications(user_id, read_at, created_at)`,

  // Chats with agents. T45 keeps each chat: its OpenCode sessions and messages as OpenCode returned
  // them, the inputs it is sent, its open questions and the agent's workspace. The agent runs in
  // a VM that keeps nothing; T45 boots one when the chat has work and restores the chat into it.
  // `updated_at` is the
  // chat's latest activity: its latest message, or its creation. A deleted chat stays as a
  // tombstone so its id never comes back, `cleanup_pending` until its VM, files and mirror are
  // gone. `boot_id` is the VM boot T45 last restored the chat into, and `vm` whether T45 keeps a
  // VM for it now. The agent's saved /work is a tarball named after the chat in the server's chat
  // workspace folder; `workspace_unsaved` while T45 gave up on saving it, as too large or refused
  // again and again, which keeps the last good one and tells the chat once.
  `CREATE TABLE chats (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT,
      status TEXT CHECK (status IN ('running', 'waiting', 'failed', 'interrupted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      cleanup_pending INTEGER NOT NULL DEFAULT 0,
      boot_id TEXT,
      vm TEXT NOT NULL DEFAULT 'asleep' CHECK (vm IN ('awake', 'asleep')),
      stop_through INTEGER,
      workspace_unsaved INTEGER NOT NULL DEFAULT 0
    )`,
  `CREATE TABLE chat_origins (
      chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id),
      owner_user_id TEXT REFERENCES users(id),
      trigger TEXT,
      state TEXT,
      CHECK ((owner_user_id IS NOT NULL AND trigger IS NULL AND state IS NULL)
          OR (owner_user_id IS NULL AND trigger IS NOT NULL AND state IS NOT NULL))
    )`,
  `CREATE INDEX origins_owner ON chat_origins(owner_user_id) WHERE owner_user_id IS NOT NULL`,
  `CREATE INDEX origins_step ON chat_origins(json_extract(trigger, '$.ticketId'), json_extract(trigger, '$.stepId')) WHERE trigger IS NOT NULL`,
  `CREATE INDEX chats_stop ON chats(id) WHERE stop_through IS NOT NULL`,
  // A chat's OpenCode sessions: its root and the subagents' sessions under it. A chat's VM names
  // its sessions, so everything of a session is keyed by its chat too: one VM can't reach another
  // chat's copy. `info_json` is the session as OpenCode last returned it; `tail_cursor` pages its
  // messages after the newest one captured from the running VM, and `next_ordinal` numbers the
  // next message captured.
  `CREATE TABLE chat_sessions (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      info_json TEXT NOT NULL,
      tail_cursor TEXT,
      next_ordinal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, session_id)
    )`,
  // Every message of a session, encoded as OpenCode returned it and never cut: restoring imports
  // it. `ordinal` is the session's order, which native ids don't give. `live` while OpenCode still
  // writes it, `settled` once finished, `lost` when its VM went away first.
  `CREATE TABLE chat_messages (
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('live', 'settled', 'lost')),
      json TEXT NOT NULL,
      PRIMARY KEY (chat_id, session_id, message_id),
      UNIQUE (chat_id, session_id, ordinal)
    )`,
  `CREATE INDEX chat_messages_live ON chat_messages(chat_id, session_id) WHERE state = 'live'`,
  // The inputs sent to a chat, in order: `waiting` until OpenCode admitted it under the message id
  // T45 derives from its id, `materialized` once that message is in the chat, or `cancelled`.
  // OpenCode forgets a cancel, so this is what keeps a cancelled input from coming back.
  // `payload_json` is the input as sent: its text, attachments and context.
  `CREATE TABLE chat_inputs (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      input_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting', 'admitted', 'materialized', 'cancelled')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, input_id),
      UNIQUE (chat_id, ordinal)
    )`,
  `CREATE INDEX chat_inputs_open ON chat_inputs(chat_id, ordinal)
    WHERE state IN ('waiting', 'admitted')`,
  // The questions the chat's agents asked and nobody answered yet, as the running VM lists them.
  // A question lost with its VM leaves here at the restore that tells the agent about it.
  `CREATE TABLE chat_questions (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      session_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      form_json TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, session_id, form_id)
    )`,

  `CREATE TABLE attachments (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploader_id TEXT NOT NULL,
      step_id TEXT,
      field_key TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX attachments_step ON attachments(step_id, created_at)
    WHERE step_id IS NOT NULL`,
  `CREATE TABLE chat_attachments (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      attachment_id TEXT NOT NULL REFERENCES attachments(id),
      PRIMARY KEY (chat_id, attachment_id)
    ) WITHOUT ROWID`,
  `CREATE INDEX chat_attachments_attachment ON chat_attachments(attachment_id)`,
];

class SchemaMismatchError extends Schema.TaggedError<SchemaMismatchError>()(
  "SchemaMismatchError",
  {},
) {
  override get message(): string {
    return "This database was created by a different schema; move it aside to start fresh.";
  }
}

/**
 * Creates the schema on an empty database, or checks that the database was created by these
 * statements. Called by the SQLite persistence layer before anything else reads the database.
 */
export const setupSchema = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fingerprint = Hex.encode(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(statements.join(";\n")))
      .pipe(Effect.orDie),
  );
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  if (tables.length === 0) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }
        yield* sql`CREATE TABLE schema_fingerprint (fingerprint TEXT NOT NULL)`;
        yield* sql`INSERT INTO schema_fingerprint (fingerprint) VALUES (${fingerprint})`;
      }),
    );
    return yield* Effect.log("Created the database schema");
  }
  const stored = tables.some((table) => table.name === "schema_fingerprint")
    ? yield* sql<{ readonly fingerprint: string }>`SELECT fingerprint FROM schema_fingerprint`
    : [];
  if (stored.length !== 1 || stored[0]?.fingerprint !== fingerprint) {
    return yield* new SchemaMismatchError();
  }
  yield* Effect.logDebug("Database schema is current");
});
