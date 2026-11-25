import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BlobStore from "../src/attachments/BlobStore.ts";
import { ChatDisks } from "../src/chats/ChatDisks.ts";

/** Chats' disks in the files bucket, under the instance's name. */
export const chatDisks = (bucket: R2Bucket, instance: string) => {
  const keyOf = (chatId: string) => `${instance}/chat-disks/${chatId}.tgz`;
  return Layer.succeed(ChatDisks, {
    read: (chatId) =>
      Effect.promise(async () => {
        const object = await bucket.get(keyOf(chatId));
        return object === null ? null : new Uint8Array(await object.arrayBuffer());
      }),
    save: (chatId, content) => Effect.promise(() => bucket.put(keyOf(chatId), content)),
    remove: (chatId) => Effect.promise(() => bucket.delete(keyOf(chatId))),
  });
};

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Attachment bytes in the files bucket, under the instance's name, by blob key. An upload streams
 * to a staging object while its length and sha256 are taken, so it never sits in memory whole; the
 * bucket has no rename, so it is then copied under its key and the staging object removed.
 */
export const blobs = (bucket: R2Bucket, instance: string) =>
  Layer.effect(
    BlobStore.BlobStore,
    Effect.gen(function* () {
      const random = yield* Crypto.Crypto;
      const keyOf = (key: string) => `${instance}/attachments/${key}`;
      const stagingPrefix = `${instance}/staging/`;
      const readSize = (key: string) =>
        Effect.promise(() => bucket.head(keyOf(key))).pipe(
          Effect.map((object) => object?.size ?? null),
        );

      /** Streams the body to `staging`; answers its sha256, or how many bytes came when they don't fit. */
      const stage = <E>(staging: string, body: Stream.Stream<Uint8Array, E>, sizeBytes: number) =>
        Effect.gen(function* () {
          const fixed = new FixedLengthStream(sizeBytes);
          const digest = new crypto.DigestStream("SHA-256");
          const writer = fixed.writable.getWriter();
          const hashing = digest.getWriter();
          const put = bucket.put(staging, fixed.readable);
          // A short or failed body aborts the write, so the bucket keeps nothing of it.
          put.catch(() => undefined);
          let receivedBytes = 0;
          yield* Stream.runForEach(
            body.pipe(
              Stream.takeWhile((chunk) => {
                receivedBytes += chunk.byteLength;
                return receivedBytes <= sizeBytes;
              }),
            ),
            (chunk) =>
              Effect.promise(() => Promise.all([writer.write(chunk), hashing.write(chunk)])),
          ).pipe(Effect.onError(() => Effect.promise(() => writer.abort())));
          if (receivedBytes !== sizeBytes) {
            yield* Effect.promise(() => writer.abort());
            return yield* new BlobStore.SizeMismatch({ received: receivedBytes });
          }
          yield* Effect.promise(() => Promise.all([writer.close(), hashing.close(), put]));
          return hex(yield* Effect.promise(() => digest.digest));
        });

      return BlobStore.BlobStore.of({
        readSize,
        store: (body, sizeBytes) =>
          Effect.gen(function* () {
            const staging = `${stagingPrefix}${yield* random.randomUUIDv4().pipe(Effect.orDie)}`;
            return yield* Effect.gen(function* () {
              const key = yield* stage(staging, body, sizeBytes);
              if ((yield* readSize(key)) !== null) return key;
              yield* Effect.promise(async () => {
                const staged = await bucket.get(staging);
                if (staged === null) throw new Error(`The staged upload ${staging} is gone.`);
                // The bucket checks the copy against the key, the sha256 of the staged bytes.
                await bucket.put(
                  keyOf(key),
                  staged.body.pipeThrough(new FixedLengthStream(staged.size)),
                  {
                    sha256: key,
                  },
                );
              });
              return key;
            }).pipe(Effect.ensuring(Effect.promise(() => bucket.delete(staging))));
          }),
        read: (key) =>
          Effect.promise(() => bucket.get(keyOf(key))).pipe(
            Effect.map((object) =>
              object === null
                ? null
                : {
                    sizeBytes: object.size,
                    stream: Stream.fromReadableStream({
                      evaluate: () => object.body,
                      onError: (cause) => cause,
                    }).pipe(Stream.orDie),
                  },
            ),
          ),
        // Served through the app; a signed bucket link needs S3 credentials.
        link: () => Effect.succeed(null),
        sweep: (before) =>
          Effect.promise(async () => {
            let cursor: string | undefined;
            do {
              const page = await bucket.list({
                prefix: stagingPrefix,
                ...(cursor === undefined ? {} : { cursor }),
              });
              const old = page.objects.filter((object) => object.uploaded.getTime() < before);
              if (old.length > 0) await bucket.delete(old.map((object) => object.key));
              cursor = page.truncated ? page.cursor : undefined;
            } while (cursor !== undefined);
          }),
      });
    }),
  );
