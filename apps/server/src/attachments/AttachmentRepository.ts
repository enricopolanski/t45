// @effect-diagnostics nodeBuiltinImport:off
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

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const isAttachmentId = Schema.is(AttachmentId);

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

const storedFileId = (entry: string) =>
  [entry, entry.replace(/\.part$/u, "")].find((id) => isAttachmentId(id));

export function attachmentPath(attachmentsDir: string, attachmentId: string): string | null {
  return isAttachmentId(attachmentId) ? NodePath.resolve(attachmentsDir, attachmentId) : null;
}

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
    /** Stores the body as a pending upload under a new id. */
    readonly upload: <E>(
      input: AttachmentUploadInput,
      uploader: string,
      body: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<Attachment, AttachmentSizeError | AttachmentNameError | E>;
    readonly store: (input: {
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
      readonly uploader: string;
    }) => Effect.Effect<Attachment, AttachmentNameError>;
    readonly get: (id: AttachmentId) => Effect.Effect<Attachment | null>;
    readonly forIds: (ids: ReadonlyArray<AttachmentId>) => Effect.Effect<ReadonlyArray<Attachment>>;
    readonly forStep: (stepId: string) => Effect.Effect<ReadonlyArray<Attachment>>;
    readonly bindToChat: (
      chatId: ChatId,
      files: ReadonlyArray<ChatAttachment>,
      from: string | null,
    ) => Effect.Effect<void, Refused>;
    /** The ids of the files sent to the chat. */
    readonly boundTo: (chatId: ChatId) => Effect.Effect<ReadonlyArray<AttachmentId>>;
    readonly chatsHolding: (id: AttachmentId) => Effect.Effect<ReadonlyArray<ChatId>>;
    readonly claimForStep: (input: {
      readonly id: AttachmentId;
      readonly actor: string;
      readonly stepId: string;
      readonly fieldKey: string | null;
    }) => Effect.Effect<Attachment | null>;
    readonly detach: (id: AttachmentId) => Effect.Effect<void>;
    readonly release: (chatId: ChatId) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
    readonly path: (id: AttachmentId) => string | null;
  }
>()("t45/attachments/AttachmentRepository") {}

const COLUMNS = `id, name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
  uploader_id AS "uploader", step_id AS "stepId", field_key AS "fieldKey", created_at AS "createdAt"`;

const decodeAttachment = Schema.decodeUnknownEffect(Attachment);
const decodeAttachments = Schema.decodeUnknownEffect(Schema.Array(Attachment));

const make = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const unheld = sql.literal(`step_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_attachments c WHERE c.attachment_id = attachments.id)`);

  const columns = sql.literal(COLUMNS);
  const select = (where: Statement.Fragment) =>
    sql`SELECT ${columns} FROM attachments WHERE ${where}`.pipe(
      Effect.flatMap(decodeAttachments),
      Effect.orDie,
    );

  const get: AttachmentRepository["Service"]["get"] = (id) =>
    select(sql`id = ${id}`).pipe(Effect.map(([attachment]) => attachment ?? null));

  const removeBytes = (id: string) => {
    const path = attachmentPath(attachmentsDir, id);
    return path === null
      ? Effect.void
      : Effect.forEach([path, `${path}.part`], (each) => fileSystem.remove(each, { force: true }), {
          discard: true,
        }).pipe(Effect.orDie);
  };

  const upload: AttachmentRepository["Service"]["upload"] = Effect.fnUntraced(
    function* (input, uploader, body) {
      const name = displayFileName(input.name);
      if (!name || name === "." || name === "..") return yield* new AttachmentNameError();
      const extension =
        input.type === "file"
          ? attachmentFileExtension(input.name)
          : IMAGE_ATTACHMENT_EXTENSIONS[input.mimeType];
      const id = `${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.${extension}`;
      const path = NodePath.resolve(attachmentsDir, id);
      const partPath = `${path}.part`;
      yield* Effect.gen(function* () {
        let receivedBytes = 0;
        yield* Stream.run(
          body.pipe(
            Stream.takeWhile((chunk) => {
              receivedBytes += chunk.byteLength;
              return receivedBytes <= input.sizeBytes;
            }),
          ),
          fileSystem.sink(partPath),
        ).pipe(Effect.catchTags({ PlatformError: Effect.die }));
        if (receivedBytes !== input.sizeBytes) {
          return yield* new AttachmentSizeError({
            expected: input.sizeBytes,
            received: receivedBytes,
          });
        }
        yield* fileSystem.rename(partPath, path).pipe(Effect.orDie);
      }).pipe(Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)));
      return yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, uploader_id, created_at)
      VALUES (${id}, ${name}, ${input.mimeType}, ${input.sizeBytes}, ${uploader}, ${yield* nowIso})
      RETURNING ${columns}`.pipe(
        Effect.flatMap(([row]) => decodeAttachment(row)),
        Effect.orDie,
      );
    },
  );

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - PENDING_MAX_AGE_MS));
    const removed = yield* sql<{ readonly id: string }>`DELETE FROM attachments
      WHERE created_at < ${cutoff} AND ${unheld} RETURNING id`.pipe(Effect.orDie);
    yield* Effect.forEach(removed, ({ id }) => removeBytes(id), { discard: true });
    const entries = yield* fileSystem
      .readDirectory(attachmentsDir)
      .pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* (entry) {
        const id = storedFileId(entry);
        if (id === undefined) return;
        const path = NodePath.join(attachmentsDir, entry);
        const info = yield* fileSystem.stat(path).pipe(Effect.option);
        const old = Option.exists(info, (stat) =>
          Option.exists(stat.mtime, (mtime) => now - mtime.getTime() > PENDING_MAX_AGE_MS),
        );
        if (!old) return;
        const [row] = yield* sql`SELECT 1 FROM attachments WHERE id = ${id}`.pipe(Effect.orDie);
        if (row === undefined) yield* fileSystem.remove(path, { force: true }).pipe(Effect.orDie);
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
    path: (id) => attachmentPath(attachmentsDir, id),
    get,

    upload,
    store: (input) =>
      upload(
        {
          type: "file",
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.bytes.byteLength,
        },
        input.uploader,
        Stream.succeed(input.bytes),
      ).pipe(Effect.catchTags({ AttachmentSizeError: Effect.die })),

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
        readonly uploaderId: string;
        readonly bound: number;
        readonly held: number;
      }>`SELECT id, size_bytes AS "sizeBytes", step_id AS "stepId",
          uploader_id AS "uploaderId",
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
            : row.stepId === null && row.held === 0 && row.uploaderId === from;
        if (!usable) return yield* unavailable();
      }
      yield* sql`INSERT INTO chat_attachments ${sql.insert(
        ids.map((id) => ({ chat_id: chatId, attachment_id: id })),
      )} ON CONFLICT DO NOTHING`.pipe(Effect.orDie);
    }),

    boundTo: (chatId) =>
      sql<{ readonly id: AttachmentId }>`SELECT attachment_id AS id FROM chat_attachments
        WHERE chat_id = ${chatId} ORDER BY attachment_id`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),

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

    detach: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE attachments SET step_id = NULL, field_key = NULL WHERE id = ${id}`;
            yield* sql`DELETE FROM attachments WHERE id = ${id} AND ${unheld}`;
          }),
        )
        .pipe(Effect.orDie),

    release: Effect.fnUntraced(function* (chatId) {
      const freed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bound = yield* sql<{ readonly id: string }>`DELETE FROM chat_attachments
              WHERE chat_id = ${chatId} RETURNING attachment_id AS id`;
            const ids = bound.map((row) => row.id);
            return yield* sql<{ readonly id: string }>`DELETE FROM attachments
              WHERE ${sql.in("id", ids)} AND ${unheld} RETURNING id`;
          }),
        )
        .pipe(Effect.orDie);
      yield* Effect.forEach(freed, ({ id }) => removeBytes(id), { discard: true });
    }),
  });
});

export const layer = Layer.effect(AttachmentRepository, make);
