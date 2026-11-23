#!/usr/bin/env node
/**
 * Moves the bytes of attachments stored before blob keys, files named by their attachment id in the
 * attachments directory, into the S3 bucket under their sha256:
 *
 *   DATA_DIR=<dir> T45_ATTACHMENTS_S3_ENDPOINT=<url> T45_ATTACHMENTS_S3_BUCKET=<name> \
 *   T45_ATTACHMENTS_S3_ACCESS_KEY_ID=<id> T45_ATTACHMENTS_S3_SECRET_ACCESS_KEY=<secret> \
 *   node apps/server/scripts/move-attachments-to-s3.ts [--dry-run]
 *
 * `--dry-run` only counts the attachments left to move. Run the move while the server keeps its
 * attachments in the same bucket, or while it is stopped: a server without the bucket can't read
 * the moved bytes. A local file is deleted only once the bucket holds its bytes at their full size
 * and the attachment points at them. Rerunning resumes with the attachments not yet moved.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as BlobStore from "../src/attachments/BlobStore.ts";
import * as ServerConfig from "../src/config.ts";

const BATCH_SIZE = 500;
const CONCURRENCY = 32;

const formatGigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

const countUnmoved = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [unmoved] = yield* sql<{ readonly count: number; readonly bytes: number | null }>`
    SELECT count(*) AS count, sum(size_bytes) AS bytes FROM attachments WHERE blob_key = id`;
  return { count: unmoved?.count ?? 0, bytes: unmoved?.bytes ?? 0 };
});

const moveAll = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentsDir = yield* ServerConfig.attachmentsDir;
  const blobs = yield* BlobStore.BlobStore;
  const unmoved = yield* countUnmoved;
  const progress = { seen: 0, moved: 0, movedBytes: 0, uploaded: 0, missing: 0 };

  const hashFile = (path: string) =>
    Effect.gen(function* () {
      const hash = NodeCrypto.createHash("sha256");
      yield* fileSystem
        .stream(path)
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
      return hash.digest("hex");
    });

  const move = Effect.fnUntraced(function* (id: string) {
    progress.seen += 1;
    const path = NodePath.join(attachmentsDir, id);
    const info = yield* fileSystem.stat(path).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(info)) {
      progress.missing += 1;
      return;
    }
    const size = Number(info.value.size);
    const key = yield* hashFile(path);
    let storedSize = yield* blobs.readSize(key);
    if (storedSize === null) {
      yield* blobs.put(key, path);
      progress.uploaded += 1;
      storedSize = yield* blobs.readSize(key);
    }
    if (storedSize !== size) {
      return yield* Effect.die(
        new Error(`The bucket holds ${storedSize} bytes as ${key}, ${id} has ${size}.`),
      );
    }
    // Uninterruptible, so a stopped run never leaves a moved attachment's local file behind.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* sql`UPDATE attachments SET blob_key = ${key} WHERE id = ${id} AND blob_key = ${id}`;
        yield* fileSystem.remove(path);
      }),
    );
    progress.moved += 1;
    progress.movedBytes += size;
  });

  yield* Console.log(`${unmoved.count} attachments to move, ${formatGigabytes(unmoved.bytes)}.`);
  let after = "";
  while (true) {
    const batch = yield* sql<{ readonly id: string }>`SELECT id FROM attachments
      WHERE blob_key = id AND id > ${after} ORDER BY id LIMIT ${BATCH_SIZE}`;
    const last = batch.at(-1);
    if (last === undefined) break;
    after = last.id;
    yield* Effect.forEach(batch, ({ id }) => move(id), {
      concurrency: CONCURRENCY,
      discard: true,
    });
    yield* Console.log(
      `${progress.seen}/${unmoved.count}: moved ${progress.moved} (${formatGigabytes(progress.movedBytes)}, ${progress.uploaded} new blobs), ${progress.missing} without a local file`,
    );
  }
});

const program = Effect.gen(function* () {
  if (process.argv.includes("--dry-run")) {
    const unmoved = yield* countUnmoved;
    return yield* Console.log(
      `${unmoved.count} attachments to move, ${formatGigabytes(unmoved.bytes)}.`,
    );
  }
  const bucket = yield* ServerConfig.attachmentsS3;
  if (Option.isNone(bucket)) {
    return yield* Effect.die(new Error("Set the four T45_ATTACHMENTS_S3_* variables."));
  }
  yield* moveAll.pipe(Effect.provide(BlobStore.layerS3(bucket.value)));
});

const layerDatabase = Layer.unwrap(
  Effect.gen(function* () {
    return SqliteClient.layer({ filename: yield* ServerConfig.dbPath });
  }),
);

program.pipe(
  Effect.provide(Layer.merge(layerDatabase, NodeServices.layer)),
  Effect.orDie,
  NodeRuntime.runMain,
);
