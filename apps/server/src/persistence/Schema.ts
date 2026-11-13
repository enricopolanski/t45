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

// The organization's users and sessions, agents and automations, workflows and projects, chats,
// and files.
const statements = [
  `CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'deactivated')),
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT 'slate',
      avatar_image BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  // Every session is a browser cookie from an identity sign-in. The cookie holds the
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
      avatar_color TEXT NOT NULL DEFAULT 'slate',
      avatar_image BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  // The singleton organization always exists; the first admin names it on first sign-in.
  `INSERT INTO organizations (id, name, created_at, updated_at)
    SELECT 'organization', NULL, at, at
    FROM (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at)`,

  `CREATE TABLE capabilities (
      id TEXT PRIMARY KEY NOT NULL,
      definition TEXT NOT NULL
    )`,

  // Named agents, their skills and automations, and the workflows people and agents work
  // through.
  // A named agent is its creator's alone until published, then everyone's. Every agent works in a
  // sandbox of its own, and its model is a `provider/model` slug OpenCode Go offers. Its
  // Selected capabilities live in a separate relation. Supplied agents have no creator.
  `CREATE TABLE agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '{}',
      network TEXT NOT NULL DEFAULT 'provider' CHECK (network IN ('provider', 'open')),
      is_conversational INTEGER NOT NULL DEFAULT 0,
      creator_user_id TEXT REFERENCES users(id),
      is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE UNIQUE INDEX agents_name ON agents(name COLLATE NOCASE)`,
  `CREATE TABLE agent_capabilities (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL REFERENCES capabilities(id),
      PRIMARY KEY (agent_id, capability_id)
    )`,
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
  // An Automation is a prompt for an agent; each run starts a chat with it. An archived one runs
  // no more and stays archived, as do archived agents, workflows and projects: nothing here is
  // deleted or restored.
  `CREATE TABLE automations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

  `CREATE TABLE workflows (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      creator_user_id TEXT NOT NULL REFERENCES users(id),
      editor_user_ids TEXT NOT NULL,
      is_archived INTEGER NOT NULL
    )`,
  // A workflow's steps, one row per version, each step naming the automations people run on it.
  // A version is a draft until a project adopts it, which freezes it for good; `revision` counts a
  // draft's saves. Numbers are unique per workflow, so a version has at most one successor.
  `CREATE TABLE workflow_versions (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      number INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      is_frozen INTEGER NOT NULL CHECK (is_frozen IN (0, 1)),
      steps TEXT NOT NULL,
      UNIQUE (workflow_id, number)
    )`,
  // `workflow_version_id` is the version new tickets start on; `default_assignees` names who gets
  // a step on entry, by step definition.
  `CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      workflow_version_id TEXT REFERENCES workflow_versions(id),
      name TEXT NOT NULL,
      admin_user_ids TEXT NOT NULL,
      default_assignees TEXT NOT NULL,
      slug TEXT UNIQUE,
      is_archived INTEGER NOT NULL
    )`,
  `CREATE INDEX projects_workflow ON projects(workflow_id)`,
  // Who works on a step of the workflow in a project. `step_id` is the definition id of one of
  // the workflow's own steps, the same across versions: its sub-steps have its members.
  `CREATE TABLE step_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (project_id, step_id, user_id)
    ) WITHOUT ROWID`,
  `CREATE INDEX step_members_user ON step_members(user_id)`,
  `CREATE TABLE tickets (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX tickets_project ON tickets(project_id, created_at)`,
  `CREATE TABLE workflow_comments (
      id TEXT PRIMARY KEY NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX workflow_comments_step ON workflow_comments(step_id, created_at)`,
  // One entry per successful command, written in the command's transaction and ordered by `id`.
  // `user_id` is the user on whose authority it ran; `agent_id` and `chat_id` are set when an
  // agent's execution ran it. Entries outlive what they name, so they hold no foreign keys.
  // `details` holds ids and keys only, never field values or free text.
  `CREATE TABLE command_log (
      id INTEGER PRIMARY KEY,
      command TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      chat_id TEXT,
      workflow_id TEXT,
      project_id TEXT,
      ticket_id TEXT,
      step_id TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX command_log_step ON command_log(ticket_id, step_id) WHERE step_id IS NOT NULL`,

  // In-app notifications: something new landed in a person's My work. Clicking a notification marks it read.
  `CREATE TABLE workflow_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('to_do', 'automation_ended', 'names_deactivated')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX workflow_notifications_user ON workflow_notifications(user_id, read_at, created_at)`,

  // Chats with agents. T45 keeps a chat's inputs, the OpenCode sessions and messages its
  // executions wrote, and the VM disk the last finished execution left, a file named after the chat
  // in the server's chat disks folder. `status` is `running` while an execution is
  // owed, which a server start runs again. `updated_at` is the chat's latest activity.
  // A deleted chat stays as a tombstone so its id never comes back.
  `CREATE TABLE chats (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT,
      status TEXT CHECK (status IN ('running', 'failed', 'interrupted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`,
  // A conversation retains its scope even after that project is deleted.
  `CREATE TABLE chat_origins (
      chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id),
      owner_user_id TEXT REFERENCES users(id),
      project_id TEXT,
      trigger TEXT,
      CHECK ((owner_user_id IS NOT NULL AND trigger IS NULL)
          OR (owner_user_id IS NULL AND project_id IS NULL AND trigger IS NOT NULL))
    )`,
  `CREATE INDEX origins_owner ON chat_origins(owner_user_id) WHERE owner_user_id IS NOT NULL`,
  `CREATE INDEX origins_step ON chat_origins(json_extract(trigger, '$.ticketId'), json_extract(trigger, '$.stepId')) WHERE trigger IS NOT NULL`,
  `CREATE INDEX origins_automation ON chat_origins(json_extract(trigger, '$.type'), json_extract(trigger, '$.automationId')) WHERE trigger IS NOT NULL`,
  // A chat's OpenCode sessions, every session of its VM, keyed by chat so one VM can't reach
  // another chat's copy. `info_json` is the session as OpenCode last returned it.
  `CREATE TABLE chat_sessions (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      info_json TEXT NOT NULL,
      PRIMARY KEY (chat_id, session_id)
    )`,
  // Every message of a session, encoded as OpenCode returned it. `ordinal` is the session's order,
  // which native ids don't give. `committed` once its execution finished, as its saved disk has it.
  // `is_live` ends with the execution even when OpenCode never completed the native message.
  `CREATE TABLE chat_messages (
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      json TEXT NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
      committed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, session_id, message_id),
      UNIQUE (chat_id, session_id, ordinal)
    )`,
  // The inputs sent to a chat, in order. An input is pending until its user message is stored, and
  // an execution sends those absent from its saved disk. The SQL comment deliberately bumps the
  // fingerprint to refuse databases whose inputs and message metadata used separate context records.
  `CREATE TABLE chat_inputs (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      input_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      payload_json TEXT NOT NULL, -- text and attachments carrying inline contextId
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, input_id),
      UNIQUE (chat_id, ordinal)
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
