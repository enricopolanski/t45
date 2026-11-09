/**
 * The database schema, as the statements that create it on an empty database. Until the first
 * release, deploys start from an empty database, so a schema change edits these statements in
 * place: the fingerprint of the statements changes, and a database created by other statements is
 * refused at startup.
 */
import { Agent, WORKFLOW_ASSISTANT_ID } from "@t45/contracts/models/Agent";
import { WORKFLOW_DRAFTING_MCP, WORKFLOW_INSTANCE_MCP } from "@t45/core/agentTools";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Defaults apply only to fresh databases; later changes belong to the organization.
const workflowDesigner = {
  id: "workflow-designer",
  name: "Workflow designer",
  instructions: `Help the member design a reusable workflow. Clarify the process and expected outputs,
then use the workflow draft tool to propose a complete blueprint. Submit the complete draft for revisions.
Explain that the member saves the blueprint, then configures and publishes a workflow from it.`,
  model: "opencode-go/deepseek-v4.1-flash",
  files: {},
  skills: [],
  mcpServers: { [WORKFLOW_DRAFTING_MCP.name]: WORKFLOW_DRAFTING_MCP.server },
  permissions: { network: "provider" },
  isConversational: true,
  status: "active",
} satisfies Omit<Agent, "createdAt" | "updatedAt">;

const workflowAssistant = {
  ...workflowDesigner,
  id: WORKFLOW_ASSISTANT_ID,
  name: "Workflow assistant",
  instructions: `Help the member operate the workflow bound to this conversation. Use get_workflow and get_ticket to obtain current definitions, fields and IDs before making changes. Never invent IDs. Confirm what the member wants before making ambiguous changes. Only claim a write succeeded after its tool returns success. You cannot mark steps done or edit workflow definitions.`,
  mcpServers: { [WORKFLOW_INSTANCE_MCP.name]: WORKFLOW_INSTANCE_MCP.server },
} satisfies Omit<Agent, "createdAt" | "updatedAt">;

const encodeFiles = Schema.encodeEffect(Schema.fromJsonString(Agent.fields.files));
const encodeMcpServers = Schema.encodeEffect(Schema.fromJsonString(Agent.fields.mcpServers));

// The organization's users and sessions, agents and automations, workflows, chats, and files.
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

  // Named agents, their skills and automations, and the workflows people and agents work
  // through.
  // Named agents are organization-wide. Every agent works in a sandbox of its own, and its model
  // is a `provider/model` slug OpenCode Go offers. Admins choose which agents members can
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
  // An Automation starts a chat with its agent: when `next_run_at`
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
      is_archived INTEGER NOT NULL
    )`,
  // The automationIds SQL comments in workflows and tickets deliberately change the raw-SQL
  // fingerprint so databases containing the old embedded automation objects are refused.
  `CREATE TABLE workflows (
      id TEXT PRIMARY KEY NOT NULL,
      definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
      name TEXT NOT NULL,
      responsible_user_id TEXT NOT NULL,
      admin_user_ids TEXT NOT NULL,
      default_assignments TEXT NOT NULL, -- assignee and shared automationIds by step definition
      slug TEXT UNIQUE,
      is_public INTEGER NOT NULL,
      is_archived INTEGER NOT NULL
    )`,
  `CREATE INDEX workflows_definition ON workflows(definition_id)`,
  `CREATE TABLE tickets (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL,
      steps TEXT NOT NULL, -- runtime steps reference shared automationIds
      created_at TEXT NOT NULL
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

  // In-app notifications: something new landed in a person's My work. Clicking a notification marks it read.
  `CREATE TABLE workflow_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('to_do', 'automation_ended', 'needs_responsible',
        'names_deactivated')),
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
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
  // A conversation retains its scope even after that workflow is deleted.
  `CREATE TABLE chat_origins (
      chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id),
      owner_user_id TEXT REFERENCES users(id),
      workflow_id TEXT,
      trigger TEXT,
      CHECK ((owner_user_id IS NOT NULL AND trigger IS NULL)
          OR (owner_user_id IS NULL AND workflow_id IS NULL AND trigger IS NOT NULL))
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
  // an execution sends those absent from its saved disk. `payload_json` is the input as sent: its text, attachments
  // and context.
  `CREATE TABLE chat_inputs (
      chat_id TEXT NOT NULL REFERENCES chats(id),
      input_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
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
        const at = DateTime.formatIso(yield* DateTime.now);
        for (const agent of [workflowDesigner, workflowAssistant])
          yield* sql`INSERT INTO agents ${sql.insert({
            id: agent.id,
            name: agent.name,
            instructions: agent.instructions,
            model: agent.model,
            files: yield* encodeFiles(agent.files),
            mcp_servers: yield* encodeMcpServers(agent.mcpServers),
            network: agent.permissions.network,
            is_conversational: Number(agent.isConversational),
            status: agent.status,
            created_at: at,
            updated_at: at,
          })}`;
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
