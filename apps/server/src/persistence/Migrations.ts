/**
 * The database schema, as numbered migrations. Startup runs those a database hasn't recorded, in
 * one transaction, and records them in `effect_sql_migrations`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./Migrations/001_Initial.ts";
import Migration0002 from "./Migrations/002_AgentCapabilities.ts";
import Migration0003 from "./Migrations/003_ChatReports.ts";
import Migration0004 from "./Migrations/004_Collections.ts";
import Migration0005 from "./Migrations/005_UrlFieldValues.ts";
import Migration0006 from "./Migrations/006_CollectionColumnOrder.ts";

/**
 * Append only. The migrator skips every id up to the highest a database has recorded, so a
 * listed migration is never edited, renumbered or removed: change the schema with the next one.
 */
const migrations = [
  [1, "Initial", Migration0001],
  [2, "AgentCapabilities", Migration0002],
  [3, "ChatReports", Migration0003],
  [4, "Collections", Migration0004],
  [5, "UrlFieldValues", Migration0005],
  [6, "CollectionColumnOrder", Migration0006],
] as const;

class PremigrationDatabaseError extends Schema.TaggedError<PremigrationDatabaseError>()(
  "PremigrationDatabaseError",
  {},
) {
  override get message(): string {
    return "This database predates migrations; move it aside to start fresh.";
  }
}

const migrate = Migrator.make({});

/** Brings the database to this build's schema. Runs before anything else reads it. */
export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fingerprinted = yield* sql`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_fingerprint'`;
  if (fingerprinted.length > 0) return yield* new PremigrationDatabaseError();
  const ran = yield* migrate({
    loader: Migrator.fromRecord(
      Object.fromEntries(migrations.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
  yield* ran.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrated the database", {
        migrations: ran.map(([id, name]) => `${id}_${name}`),
      });
});
