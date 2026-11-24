// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AwsClient } from "aws4fetch";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

/**
 * Attachment bytes by blob key, the sha256 hex of the bytes, so identical uploads share one blob.
 * Bytes stored before blob keys are keyed by their attachment id. Blobs are never deleted: any
 * number of attachments may share one.
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    /** The size of the stored bytes, or null when the store has none under `key`. */
    readonly readSize: (key: string) => Effect.Effect<number | null>;
    /** Stores the file at `path` under `key`, the sha256 hex of its bytes; may move the file. */
    readonly put: (key: string, path: string) => Effect.Effect<void>;
    /** The stored bytes and their size, or null when the store has none under `key`. */
    readonly read: (key: string) => Effect.Effect<StoredBytes | null>;
    /**
     * A short-lived link the browser can fetch the bytes from directly, answering with `response`'s
     * headers, or null when the bytes are only served through the app.
     */
    readonly link: (key: string, response: LinkResponse) => Effect.Effect<string | null>;
  }
>()("t45/attachments/BlobStore") {}

export interface LinkResponse {
  readonly contentType: string;
  readonly contentDisposition: string | null;
}

export interface StoredBytes {
  readonly sizeBytes: number;
  readonly stream: Stream.Stream<Uint8Array>;
}

/** Blobs as files named by their key in the attachments directory. */
const makeDirectoryStore = Effect.gen(function* () {
  const attachmentsDir = yield* ServerConfig.attachmentsDir;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathOf = (key: string) => NodePath.join(attachmentsDir, key);
  const readSize = (key: string) =>
    fileSystem.stat(pathOf(key)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.orDie,
    );
  return BlobStore.of({
    readSize,
    put: (key, path) => fileSystem.rename(path, pathOf(key)).pipe(Effect.orDie),
    read: Effect.fnUntraced(function* (key) {
      const sizeBytes = yield* readSize(key);
      if (sizeBytes === null) return null;
      return { sizeBytes, stream: fileSystem.stream(pathOf(key)).pipe(Stream.orDie) };
    }),
    link: () => Effect.succeed(null),
  });
});

const HOUR_SECONDS = 3600;

/** Blobs as objects named by their key in an S3-compatible bucket, such as Cloudflare R2. */
export const layerS3 = (bucket: {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const directory = yield* makeDirectoryStore;
      // R2 takes the region "auto". The client retries 5xx and 429 answers.
      const client = new AwsClient({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: Redacted.value(bucket.secretAccessKey),
        service: "s3",
        region: "auto",
      });
      const bucketUrl = `${bucket.endpoint.replace(/\/+$/u, "")}/${bucket.bucket}`;
      // Some connections to the bucket never get past the handshake; a fresh attempt gets through.
      const send = (key: string, init: RequestInit) =>
        Effect.tryPromise((signal) =>
          client.fetch(`${bucketUrl}/${key}`, { ...init, signal }),
        ).pipe(
          Effect.retry({ times: 5, schedule: Schedule.exponential("1 second") }),
          Effect.orDie,
        );
      const dieWithStatus = (response: Response, key: string) =>
        Effect.die(new Error(`The bucket answered ${response.status} for blob ${key}.`));

      return BlobStore.of({
        readSize: Effect.fnUntraced(function* (key) {
          const response = yield* send(key, { method: "HEAD" });
          if (response.status === 404) return null;
          if (response.status !== 200) return yield* dieWithStatus(response, key);
          return Number(response.headers.get("content-length"));
        }),

        put: Effect.fnUntraced(function* (key, path) {
          // A file-backed body streams from disk and is read afresh for each retry.
          const body = yield* Effect.promise(() => NodeFS.openAsBlob(path));
          // The key is the body's sha256, so a bucket that checks the payload hash refuses bytes
          // that don't match it.
          const response = yield* send(key, {
            method: "PUT",
            body,
            headers: { "x-amz-content-sha256": key },
          });
          if (response.status !== 200) return yield* dieWithStatus(response, key);
        }),

        read: Effect.fnUntraced(function* (key) {
          // Transition: attachments stored before the bucket keep their bytes in the attachments
          // directory until scripts/move-attachments-to-s3.ts moves them, so a key that is still a
          // local file is read from there. Remove this once that backfill has run.
          const moving = yield* directory.read(key);
          if (moving !== null) return moving;
          const response = yield* send(key, { method: "GET" });
          if (response.status === 404) return null;
          if (response.status !== 200) return yield* dieWithStatus(response, key);
          const sizeBytes = Number(response.headers.get("content-length"));
          const body = response.body;
          if (body === null) return { sizeBytes, stream: Stream.empty };
          return {
            sizeBytes,
            stream: Stream.fromReadableStream({
              evaluate: () => body,
              onError: (cause) => cause,
            }).pipe(Stream.orDie),
          };
        }),

        link: Effect.fnUntraced(function* (key, response) {
          if ((yield* directory.readSize(key)) !== null) return null;
          const url = new URL(`${bucketUrl}/${key}`);
          url.searchParams.set("X-Amz-Expires", String(2 * HOUR_SECONDS));
          url.searchParams.set("response-content-type", response.contentType);
          if (response.contentDisposition !== null) {
            url.searchParams.set("response-content-disposition", response.contentDisposition);
          }
          url.searchParams.set("response-cache-control", `private, max-age=${HOUR_SECONDS}`);
          // Signed as of the start of the hour, so the link stays the same for that hour and the
          // browser reuses its cached bytes; it is valid for at least another hour.
          const now = yield* Clock.currentTimeMillis;
          const signedAt = DateTime.makeUnsafe(now - (now % (HOUR_SECONDS * 1000)));
          const signed = yield* Effect.promise(() =>
            client.sign(url.toString(), {
              method: "GET",
              aws: {
                signQuery: true,
                datetime: DateTime.formatIso(signedAt).replace(/[:-]|\.\d{3}/gu, ""),
              },
            }),
          );
          return signed.url;
        }),
      });
    }),
  );

/** The bucket when `ServerConfig.attachmentsS3` configures one, else the attachments directory. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const bucket = yield* ServerConfig.attachmentsS3;
    return Option.isSome(bucket)
      ? layerS3(bucket.value)
      : Layer.effect(BlobStore, makeDirectoryStore);
  }),
);
