#!/usr/bin/env node
/**
 * Snapshots an instance's database from its Durable Object on the Cloudflare server: copies it into
 * a new SQLite file, uploads that gzipped to an R2 bucket, and records the snapshot, and how many
 * the bucket holds, in a Workers KV namespace:
 *
 *   T45_EXPORT_URL=https://<worker> T45_EXPORT_TOKEN=<token> \
 *   T45_BACKUP_S3_ENDPOINT=<url> T45_BACKUP_S3_BUCKET=<name> \
 *   T45_BACKUP_S3_ACCESS_KEY_ID=<id> T45_BACKUP_S3_SECRET_ACCESS_KEY=<secret> \
 *   T45_BACKUP_KV_NAMESPACE_ID=<id> \
 *   node apps/server/scripts/backup-cloudflare-to-r2.ts <directory>
 *
 * The Worker needs the same `T45_EXPORT_TOKEN` secret; Wrangler writes the namespace, as signed in.
 * The copy stays in `<directory>` as `<instance>-<time>.sqlite`. The bucket holds it as
 * `<instance>/<time>.sqlite.gz`; the namespace holds `<instance>/count`, and `<instance>/<time>` with
 * the copy's row counts and checks and the object's point-in-time-recovery bookmark. Restore a copy
 * with transfer-to-cloudflare.ts into an instance with no database yet.
 *
 * The instance keeps serving while it is read, so a row written meanwhile may be in the copy or not.
 * Tables are read children first: a row's parents are in the copy unless deleted meanwhile, and the
 * record counts the foreign keys left broken. The transfer activates no copy with any, so repair
 * those first, or take the copy while nothing writes.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { AwsClient } from "aws4fetch";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  bindable,
  type Encoded,
  keyOf,
  placeholder,
  quoteName,
  type TableShape,
  travelling,
} from "../src/persistence/Transfer.ts";

/** R2 takes parts of one size, all but the last. */
const PART_BYTES = 64 * 1024 * 1024;

const Exported = Schema.Struct({
  instance: Schema.String,
  tables: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      sql: Schema.String,
      columns: Schema.Array(Schema.String),
      key: Schema.Array(Schema.String),
    }),
  ),
  ddl: Schema.Array(Schema.Struct({ name: Schema.String, sql: Schema.String })),
  databaseSize: Schema.Number,
  bookmark: Schema.String,
});
const Page = Schema.Struct({ rows: Schema.Array(Schema.Array(Schema.Unknown)) });

/** What the namespace records about a snapshot. */
const encodeSnapshot = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      object: Schema.String,
      bytes: Schema.Number,
      databaseSize: Schema.Number,
      bookmark: Schema.String,
      rows: Schema.Record(Schema.String, Schema.Number),
      quickCheck: Schema.String,
      brokenForeignKeys: Schema.Number,
      startedAt: Schema.String,
      finishedAt: Schema.String,
    }),
  ),
);

/** Each table before those it references: a row copied before its parents finds them later. */
const childrenFirst = (db: NodeSqlite.DatabaseSync, tables: ReadonlyArray<TableShape>) => {
  const unvisited = new Map(tables.map((table) => [table.name, table]));
  const parentsFirst: Array<TableShape> = [];
  const visit = (table: TableShape | undefined) => {
    if (table === undefined || !unvisited.delete(table.name)) return;
    const parents = db.prepare(`PRAGMA foreign_key_list(${quoteName(table.name)})`).all();
    for (const parent of parents) visit(unvisited.get(String(parent["table"])));
    parentsFirst.push(table);
  };
  for (const table of tables) visit(table);
  return parentsFirst.toReversed();
};

const program = Effect.gen(function* () {
  const directory = process.argv[2];
  if (directory === undefined)
    return yield* Effect.die(new Error("Pass the directory to keep the copy in."));
  const url = yield* Config.String("T45_EXPORT_URL");
  const token = yield* Config.Redacted("T45_EXPORT_TOKEN");
  const endpoint = yield* Config.String("T45_BACKUP_S3_ENDPOINT");
  const bucket = yield* Config.String("T45_BACKUP_S3_BUCKET");
  const accessKeyId = yield* Config.String("T45_BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = yield* Config.Redacted("T45_BACKUP_S3_SECRET_ACCESS_KEY");
  const namespaceId = yield* Config.String("T45_BACKUP_KV_NAMESPACE_ID");

  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const call = <A>(schema: Schema.Codec<A, unknown>, body: unknown) =>
    HttpClientRequest.post(`${url.replace(/\/+$/u, "")}/api/export`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.bodyJsonUnsafe(body),
      client.execute,
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    );

  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const time = startedAt.replace(/\.\d+Z$/u, "Z").replaceAll(":", "-");
  const { instance, tables, ddl, databaseSize, bookmark } = yield* call(Exported, { op: "schema" });
  const path = NodePath.join(directory, `${instance}-${time}.sqlite`);
  const db = new NodeSqlite.DatabaseSync(path, { enableForeignKeyConstraints: false });
  for (const table of tables) db.exec(table.sql);

  const rows: Record<string, number> = {};
  for (const table of childrenFirst(db, tables)) {
    const started = yield* Clock.currentTimeMillis;
    const columns = travelling(table).map(quoteName).join(", ");
    let after: ReadonlyArray<Encoded> | null = null;
    let count = 0;
    while (true) {
      const page = (yield* call(Page, { op: "rows", table, after })).rows as ReadonlyArray<
        ReadonlyArray<Encoded>
      >;
      const last = page.at(-1);
      if (last === undefined) break;
      db.exec("BEGIN");
      for (const row of page)
        db.prepare(
          `INSERT INTO ${quoteName(table.name)} (${columns}) VALUES (${row.map(placeholder).join(", ")})`,
        ).run(...row.flatMap((value) => bindable(value) ?? []));
      db.exec("COMMIT");
      count += page.length;
      after = keyOf(table, last);
    }
    rows[table.name] = count;
    const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
    yield* Console.log(`${table.name}: ${count} rows, ${seconds.toFixed(1)} s`);
  }
  for (const { sql } of ddl) db.exec(sql);
  const quickCheck = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(row["quick_check"]))
    .join("; ");
  const brokenForeignKeys = db.prepare("PRAGMA foreign_key_check").all().length;
  db.close();
  yield* Console.log(`Copied to ${path}: ${quickCheck}, ${brokenForeignKeys} broken foreign keys.`);

  const s3 = new AwsClient({
    accessKeyId,
    secretAccessKey: Redacted.value(secretAccessKey),
    service: "s3",
    region: "auto",
  });
  const bucketUrl = `${endpoint.replace(/\/+$/u, "")}/${bucket}`;
  // Some connections to the bucket never get past the handshake; a fresh attempt gets through.
  const send = (target: string, init: RequestInit) =>
    Effect.tryPromise(async (signal) => {
      const response = await s3.fetch(`${bucketUrl}/${target}`, { ...init, signal });
      if (!response.ok)
        throw new Error(`The bucket answered ${response.status}: ${await response.text()}`);
      return await response.text().then((text) => ({ text, etag: response.headers.get("etag") }));
    }).pipe(Effect.retry({ times: 5, schedule: Schedule.exponential("1 second") }), Effect.orDie);

  const gzipped = `${path}.gz`;
  yield* Effect.promise(() =>
    NodeStreamPromises.pipeline(
      NodeFS.createReadStream(path),
      NodeZlib.createGzip(),
      NodeFS.createWriteStream(gzipped),
    ),
  );
  const object = `${instance}/${time}.sqlite.gz`;
  const created = yield* send(`${object}?uploads`, { method: "POST" });
  const uploadId = encodeURIComponent(/<UploadId>(.+?)<\/UploadId>/u.exec(created.text)?.[1] ?? "");
  const file = yield* Effect.promise(() => NodeFS.openAsBlob(gzipped));
  const parts: Array<string> = [];
  for (let start = 0; start < file.size; start += PART_BYTES) {
    const body = yield* Effect.promise(() => file.slice(start, start + PART_BYTES).arrayBuffer());
    const part = parts.length + 1;
    const { etag } = yield* send(`${object}?partNumber=${part}&uploadId=${uploadId}`, {
      method: "PUT",
      body,
    });
    parts.push(`<Part><PartNumber>${part}</PartNumber><ETag>${etag}</ETag></Part>`);
  }
  yield* send(`${object}?uploadId=${uploadId}`, {
    method: "POST",
    body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
  });
  NodeFS.rmSync(gzipped);
  yield* Console.log(`Uploaded ${object}: ${(file.size / 1e6).toFixed(1)} MB.`);

  let snapshots = 0;
  let continuation: string | undefined;
  do {
    const query = new URLSearchParams({ "list-type": "2", prefix: `${instance}/` });
    if (continuation !== undefined) query.set("continuation-token", continuation);
    const listed = yield* send(`?${query}`, { method: "GET" });
    snapshots += listed.text.match(/<Key>/gu)?.length ?? 0;
    continuation = /<NextContinuationToken>(.+?)<\/NextContinuationToken>/u.exec(listed.text)?.[1];
  } while (continuation !== undefined);

  const wrangler = NodePath.join(import.meta.dirname, "../node_modules/.bin/wrangler");
  const put = (key: string, value: string) =>
    Effect.sync(() =>
      NodeChildProcess.execFileSync(
        wrangler,
        ["kv", "key", "put", key, value, "--namespace-id", namespaceId, "--remote"],
        { stdio: ["ignore", "ignore", "inherit"] },
      ),
    );
  const finishedAt = DateTime.formatIso(yield* DateTime.now);
  yield* put(
    `${instance}/${time}`,
    yield* encodeSnapshot({
      object,
      bytes: file.size,
      databaseSize,
      bookmark,
      rows,
      quickCheck,
      brokenForeignKeys,
      startedAt,
      finishedAt,
    }),
  );
  yield* put(`${instance}/count`, String(snapshots));
  yield* Console.log(`Recorded ${instance}/${time}; ${instance} has ${snapshots} snapshots.`);
});

program.pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
