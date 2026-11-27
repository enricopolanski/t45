#!/usr/bin/env node
/**
 * Copies an instance's SQLite database into its Durable Object on the Cloudflare server, then checks
 * every table against the source:
 *
 *   T45_TRANSFER_URL=https://<worker> T45_IMPORT_TOKEN=<token> \
 *   node apps/server/scripts/transfer-to-cloudflare.ts <copy.sqlite> [--activate]
 *
 * Give it a consistent copy (`sqlite3 statev2.sqlite ".backup copy.sqlite"`), never the live file.
 * The Worker needs the same `T45_IMPORT_TOKEN` secret, and its instance must have no database yet:
 * the object stays closed until the copy is activated. It keeps the source's own schema, migration
 * ledger included, and each value's storage class. Rerunning resumes after the last batch the object
 * stored. `--activate` opens the instance once every table matches and no foreign key is broken.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  bindable,
  DIGEST_ROWS,
  digestQuery,
  type Encoded,
  keyAlias,
  placeholder,
  quoteName,
  shapesOf,
  sizeOf,
  travelling,
} from "../src/persistence/Transfer.ts";

/** A batch's rough size; a single larger row travels alone. */
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_ROWS = 5000;

const encode = (value: unknown): Encoded => {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return ["i", value.toString()];
  if (value instanceof Uint8Array) return ["b", Buffer.from(value).toString("base64")];
  throw new Error(`Unexpected value ${String(value)}`);
};
const Progress = Schema.Struct({
  progress: Schema.Record(Schema.String, Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const Verified = Schema.Struct({
  count: Schema.Number,
  digest: Schema.String,
  last: Schema.NullOr(Schema.Array(Schema.Unknown)),
});
const Finished = Schema.Struct({ foreignKeyErrors: Schema.Number });

const program = Effect.gen(function* () {
  const source = process.argv[2];
  if (source === undefined) return yield* Effect.die(new Error("Pass the copy of the database."));
  const activate = process.argv.includes("--activate");
  const url = yield* Config.String("T45_TRANSFER_URL");
  const token = yield* Config.Redacted("T45_IMPORT_TOKEN");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const call = <A>(schema: Schema.Codec<A, unknown>, body: unknown) =>
    HttpClientRequest.post(`${url.replace(/\/+$/u, "")}/api/transfer`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.bodyJsonUnsafe(body),
      client.execute,
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    );

  const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  const { tables, ddl } = shapesOf((query) => db.prepare(query).all());
  const { progress } = yield* call(Progress, { op: "begin", tables });

  for (const table of tables) {
    const started = yield* Clock.currentTimeMillis;
    const columns = travelling(table).map(quoteName).join(", ");
    const key = table.key.map(quoteName).join(", ");
    const resume = (progress[table.name] ?? null) as ReadonlyArray<Encoded> | null;
    const where = resume === null ? "" : `WHERE (${key}) > (${resume.map(placeholder).join(", ")})`;
    const select = db.prepare(
      `SELECT ${columns} FROM ${quoteName(table.name)} ${where} ORDER BY ${key}`,
    );
    select.setReadBigInts(true);
    select.setReturnArrays(true);
    let batch: Array<Array<Encoded>> = [];
    let bytes = 0;
    let rows = 0;
    let total = 0;
    const send = Effect.suspend(() => {
      const rowsToSend = batch;
      batch = [];
      bytes = 0;
      return rowsToSend.length === 0
        ? Effect.void
        : call(Schema.Unknown, { op: "rows", table, rows: rowsToSend });
    });
    for (const row of select.iterate(...(resume ?? []).map((value) => bindable(value) ?? null))) {
      const encoded = (row as unknown as Array<unknown>).map(encode);
      const size = encoded.reduce((sum: number, value) => sum + sizeOf(value), 0);
      if (batch.length > 0 && (bytes + size > BATCH_BYTES || batch.length >= BATCH_ROWS))
        yield* send;
      batch.push(encoded);
      bytes += size;
      rows += 1;
      total += size;
    }
    yield* send;
    const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
    yield* Console.log(
      `${table.name}: ${rows} rows, ${(total / 1e6).toFixed(1)} MB, ${seconds.toFixed(1)} s${resume === null ? "" : " (resumed)"}`,
    );
  }

  const { foreignKeyErrors } = yield* call(Finished, { op: "finish", ddl });
  yield* Console.log(
    `Indexes, views and triggers created; ${foreignKeyErrors} broken foreign keys.`,
  );

  let mismatches = 0;
  for (const table of tables) {
    let after: ReadonlyArray<Encoded> | null = null;
    let count = 0;
    while (true) {
      const hash = NodeCrypto.createHash("sha256");
      let chunk = 0;
      let last: Array<Encoded> | null = null;
      const query = db.prepare(digestQuery(table, after));
      query.setReadBigInts(true);
      for (const row of query.iterate(
        ...(after ?? []).map((value) => bindable(value) ?? null),
        DIGEST_ROWS,
      )) {
        const record = row as Record<string, unknown>;
        hash.update(`${String(record["row_text"])}\n`);
        chunk += 1;
        last = table.key.map((_name, index) => encode(record[keyAlias(index)]));
      }
      const theirs = yield* call(Verified, { op: "verify", table, after });
      if (theirs.count !== chunk || theirs.digest !== hash.digest("hex")) {
        mismatches += 1;
        yield* Console.log(`${table.name}: differs after ${count} rows`);
        break;
      }
      count += chunk;
      if (chunk < DIGEST_ROWS) break;
      after = last;
    }
    yield* Console.log(`${table.name}: ${count} rows match`);
  }

  if (mismatches > 0 || foreignKeyErrors > 0)
    return yield* Effect.die(
      new Error(`${mismatches} tables differ; ${foreignKeyErrors} broken foreign keys.`),
    );
  if (activate) {
    yield* call(Schema.Unknown, { op: "activate" });
    yield* Console.log("Activated: the instance starts on its next request.");
  } else yield* Console.log("Every table matches. Rerun with --activate to open the instance.");
});

program.pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
