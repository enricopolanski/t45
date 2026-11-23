// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  type ATTACHMENT_IMAGE_MIME_TYPES,
  Attachment,
  AttachmentId,
  type ChatAttachment,
} from "@t45/contracts/models/Attachment";
import { type AttachmentUploadInput } from "@t45/contracts/resources/Attachments";
import { type ChatId, Refused } from "@t45/contracts/models/Chat";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import * as BlobStore from "./BlobStore.ts";

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const isAttachmentId = Schema.is(AttachmentId);

/** An image upload's stored extension, by its (schema-checked) mime type. */
const IMAGE_ATTACHMENT_EXTENSIONS = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} satisfies Record<(typeof ATTACHMENT_IMAGE_MIME_TYPES)[number], string>;

// Image uploads' extensions plus "jpeg", which a generic "photo.jpeg" keeps.
const INLINE_IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

/** A generic file's stored extension: its own when short and plain, else `bin`. */
function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin";
}

const displayFileName = (name: string) =>
  [...(name.split(/[/\\]/u).at(-1) ?? "")]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .trim()
    .slice(0, 200);

/** Images render inline; every other stored extension downloads. */
export function attachmentIsInlineImage(attachmentId: string): boolean {
  return (
    isAttachmentId(attachmentId) &&
    INLINE_IMAGE_EXTENSIONS.has(NodePath.extname(attachmentId).slice(1))
  );
}

export class AttachmentNameError extends Schema.TaggedError<AttachmentNameError>()(
  "AttachmentNameError",
  {},
) {
  override get message() {
    return "A file needs a name.";
  }
}

export class AttachmentSizeError extends Schema.TaggedError<AttachmentSizeError>()(
  "AttachmentSizeError",
  { expected: Schema.Number, received: Schema.Number },
) {
  override get message() {
    return `Body was ${this.received} bytes, expected ${this.expected}.`;
  }
}

export class AttachmentRepository extends Context.Service<
  AttachmentRepository,
  {
    /** Stores the body as a pending upload under a new id, sharing the blob of identical bytes. */
    readonly upload: <E>(
      input: AttachmentUploadInput,
      uploader: string,
      body: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<Attachment, AttachmentSizeError | AttachmentNameError | E>;
    readonly get: (id: AttachmentId) => Effect.Effect<Attachment | null>;
    readonly forIds: (ids: ReadonlyArray<AttachmentId>) => Effect.Effect<ReadonlyArray<Attachment>>;
    readonly forStep: (stepId: string) => Effect.Effect<ReadonlyArray<Attachment>>;
    readonly bindToChat: (
      chatId: ChatId,
      files: ReadonlyArray<ChatAttachment>,
      from: string | null,
    ) => Effect.Effect<void, Refused>;
    readonly chatsHolding: (id: AttachmentId) => Effect.Effect<ReadonlyArray<ChatId>>;
    readonly claimForStep: (input: {
      readonly id: AttachmentId;
      readonly actor: string;
      readonly stepId: string;
      readonly fieldKey: string | null;
    }) => Effect.Effect<Attachment | null>;
    /** Gives a pending upload of `actor` to a collection record's file field. */
    readonly claimForCollection: (input: {
      readonly id: AttachmentId;
      readonly actor: string;
      readonly collectionId: string;
      readonly fieldKey: string;
    }) => Effect.Effect<Attachment | null>;
    readonly detach: (id: AttachmentId) => Effect.Effect<void>;
    readonly release: (chatId: ChatId) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
    /** The attachment's stored bytes, or null when it or its bytes are gone. */
    readonly read: (id: AttachmentId) => Effect.Effect<BlobStore.StoredBytes | null>;
  }
>()("t45/attachments/AttachmentRepository") {}

const COLUMNS = `id, name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
  uploader_id AS "uploader", step_id AS "stepId", collection_id AS "collectionId",
  field_key AS "fieldKey", created_at AS "createdAt"`;

const decodeAttachment = Schema.decodeUnknownEffect(Attachment);
const decodeAttachments = Schema.decodeUnknownEffect(Schema.Array(Attachment));

const make = Effect.gen(function* () {
  const attachmentsDir = yield* ServerConfig.attachmentsDir;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const blobs = yield* BlobStore.BlobStore;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const unheld = sql.literal(`step_id IS NULL AND collection_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_attachments c WHERE c.attachment_id = attachments.id)
    AND NOT EXISTS (SELECT 1 FROM completed_step_files c WHERE c.attachment_id = attachments.id)`);

  const columns = sql.literal(COLUMNS);
  const select = (where: Statement.Fragment) =>
    sql`SELECT ${columns} FROM attachments WHERE ${where}`.pipe(
      Effect.flatMap(decodeAttachments),
      Effect.orDie,
    );

  const get: AttachmentRepository["Service"]["get"] = (id) =>
    select(sql`id = ${id}`).pipe(Effect.map(([attachment]) => attachment ?? null));

  const upload: AttachmentRepository["Service"]["upload"] = Effect.fnUntraced(
    function* (input, uploader, body) {
      const name = displayFileName(input.name);
      if (!name || name === "." || name === "..") return yield* new AttachmentNameError();
      const extension =
        input.type === "file"
          ? attachmentFileExtension(input.name)
          : IMAGE_ATTACHMENT_EXTENSIONS[input.mimeType];
      const id = `${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.${extension}`;
      // The bytes arrive in a file of their own, so the blob key is known before anything is stored.
      const partPath = NodePath.resolve(attachmentsDir, `${id}.part`);
      const blobKey = yield* Effect.gen(function* () {
        const hash = NodeCrypto.createHash("sha256");
        let receivedBytes = 0;
        yield* Stream.run(
          body.pipe(
            Stream.takeWhile((chunk) => {
              receivedBytes += chunk.byteLength;
              return receivedBytes <= input.sizeBytes;
            }),
            Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
          ),
          fileSystem.sink(partPath),
        ).pipe(Effect.catchTags({ PlatformError: Effect.die }));
        if (receivedBytes !== input.sizeBytes) {
          return yield* new AttachmentSizeError({
            expected: input.sizeBytes,
            received: receivedBytes,
          });
        }
        const key = hash.digest("hex");
        if ((yield* blobs.readSize(key)) === null) yield* blobs.put(key, partPath);
        return key;
      }).pipe(Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)));
      return yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, uploader_id, created_at, blob_key)
      VALUES (${id}, ${name}, ${input.mimeType}, ${input.sizeBytes}, ${uploader}, ${yield* nowIso}, ${blobKey})
      RETURNING ${columns}`.pipe(
        Effect.flatMap(([row]) => decodeAttachment(row)),
        Effect.orDie,
      );
    },
  );

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - PENDING_MAX_AGE_MS));
    yield* sql`DELETE FROM attachments WHERE created_at < ${cutoff} AND ${unheld}`.pipe(
      Effect.orDie,
    );
    const entries = yield* fileSystem
      .readDirectory(attachmentsDir)
      .pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* (entry) {
        if (!entry.endsWith(".part")) return;
        const path = NodePath.join(attachmentsDir, entry);
        const info = yield* fileSystem.stat(path).pipe(Effect.option);
        // An upload's bytes arrive in a `.part` file; a day-old one was cut short.
        const old = Option.exists(info, (stat) =>
          Option.exists(stat.mtime, (mtime) => now - mtime.getTime() > PENDING_MAX_AGE_MS),
        );
        if (old) yield* fileSystem.remove(path, { force: true }).pipe(Effect.orDie);
      }),
      { discard: true },
    );
  });
  yield* sweep.pipe(
    Effect.catchDefect((cause) => Effect.logWarning("Sweeping attachments failed", { cause })),
    Effect.repeat(Schedule.spaced("15 minutes")),
    Effect.forkScoped,
  );

  return AttachmentRepository.of({
    sweep,
    get,

    read: Effect.fnUntraced(function* (id) {
      const [row] = yield* sql<{ readonly blobKey: string }>`SELECT blob_key AS "blobKey"
        FROM attachments WHERE id = ${id}`.pipe(Effect.orDie);
      return row === undefined ? null : yield* blobs.read(row.blobKey);
    }),

    upload,

    forIds: (ids) =>
      select(sql.in("id", ids)).pipe(
        Effect.map((found) => ids.flatMap((id) => found.filter((file) => file.id === id))),
      ),

    forStep: (stepId) => select(sql`step_id = ${stepId} ORDER BY created_at, id`),

    bindToChat: Effect.fnUntraced(function* (chatId, files, from) {
      const unavailable = () => new Refused({ reason: "file_unavailable" });
      const ids = files.map((file) => file.id);
      if (new Set(ids).size !== ids.length) return yield* unavailable();
      if (ids.length === 0) return;
      const rows = yield* sql<{
        readonly id: string;
        readonly sizeBytes: number;
        readonly stepId: string | null;
        readonly collectionId: string | null;
        readonly uploaderId: string;
        readonly bound: number;
        readonly held: number;
      }>`SELECT id, size_bytes AS "sizeBytes", step_id AS "stepId",
          collection_id AS "collectionId", uploader_id AS "uploaderId",
          EXISTS (SELECT 1 FROM chat_attachments c
            WHERE c.attachment_id = attachments.id AND c.chat_id = ${chatId}) AS "bound",
          EXISTS (SELECT 1 FROM chat_attachments c WHERE c.attachment_id = attachments.id) AS "held"
        FROM attachments WHERE ${sql.in("id", ids)}`.pipe(Effect.orDie);
      for (const file of files) {
        const row = rows.find((each) => each.id === file.id);
        if (row === undefined || row.sizeBytes !== file.sizeBytes) return yield* unavailable();
        if (row.bound === 1) continue;
        const usable =
          from === null
            ? row.stepId !== null
            : row.stepId === null &&
              row.collectionId === null &&
              row.held === 0 &&
              row.uploaderId === from;
        if (!usable) return yield* unavailable();
      }
      yield* sql`INSERT INTO chat_attachments ${sql.insert(
        ids.map((id) => ({ chat_id: chatId, attachment_id: id })),
      )} ON CONFLICT DO NOTHING`.pipe(Effect.orDie);
    }),

    chatsHolding: (id) =>
      sql<{ readonly chatId: ChatId }>`SELECT chat_id AS "chatId" FROM chat_attachments
        WHERE attachment_id = ${id} ORDER BY chat_id`.pipe(
        Effect.map((rows) => rows.map((row) => row.chatId)),
        Effect.orDie,
      ),

    claimForStep: (input) =>
      sql`UPDATE attachments SET step_id = ${input.stepId},
          field_key = ${input.fieldKey}
        WHERE id = ${input.id} AND step_id IS NULL AND uploader_id = ${input.actor}
          AND NOT EXISTS (SELECT 1 FROM chat_attachments c WHERE c.attachment_id = attachments.id)
        RETURNING ${columns}`.pipe(
        Effect.flatMap(decodeAttachments),
        Effect.orDie,
        Effect.map(([claimed]) => claimed ?? null),
      ),

    claimForCollection: (input) =>
      sql`UPDATE attachments SET collection_id = ${input.collectionId},
          field_key = ${input.fieldKey}
        WHERE id = ${input.id} AND ${unheld} AND uploader_id = ${input.actor}
        RETURNING ${columns}`.pipe(
        Effect.flatMap(decodeAttachments),
        Effect.orDie,
        Effect.map(([claimed]) => claimed ?? null),
      ),

    // Called inside workflow and collection transactions. Like every removal, keeps the bytes: other
    // attachments may share them.
    detach: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE attachments SET step_id = NULL, collection_id = NULL, field_key = NULL
              WHERE id = ${id}`;
            yield* sql`DELETE FROM attachments WHERE id = ${id} AND ${unheld}`;
          }),
        )
        .pipe(Effect.orDie),

    release: (chatId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const bound = yield* sql<{ readonly id: string }>`DELETE FROM chat_attachments
              WHERE chat_id = ${chatId} RETURNING attachment_id AS id`;
            const ids = bound.map((row) => row.id);
            yield* sql`DELETE FROM attachments WHERE ${sql.in("id", ids)} AND ${unheld}`;
          }),
        )
        .pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(AttachmentRepository, make).pipe(Layer.provide(BlobStore.layer));
