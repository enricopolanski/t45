import { Collection, CollectionColumnOrder } from "@t45/contracts/models/Collection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const decodeCollections = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(Collection)),
);
const encodeCollection = Schema.encodeEffect(
  Schema.Struct({
    ...Collection.fields,
    fields: Schema.fromJsonString(Collection.fields.fields),
    memberUserIds: Schema.fromJsonString(Collection.fields.memberUserIds),
    columnOrder: Schema.optionalKey(Schema.fromJsonString(CollectionColumnOrder)),
  }),
);

export class CollectionRepository extends Context.Service<
  CollectionRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Collection>>;
    readonly get: (collectionId: string) => Effect.Effect<Collection | null>;
    readonly save: (collection: Collection) => Effect.Effect<void>;
  }
>()("t45/collections/CollectionRepository") {}

export const layer = Layer.effect(
  CollectionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: Fragment) =>
      sql<{ readonly collection: string }>`SELECT json_object(
          'id', id, 'title', title, 'fields', json(fields),
          'primaryKeyFieldId', primary_key_field_id, 'memberUserIds', json(member_user_ids),
          'columnOrder', json(column_order),
          'createdAt', created_at, 'updatedAt', updated_at) AS collection
        FROM collections WHERE ${where} ORDER BY title COLLATE NOCASE`.pipe(
        Effect.flatMap((rows) => decodeCollections(rows.map((row) => row.collection))),
        Effect.orDie,
      );

    return CollectionRepository.of({
      list: read(sql`1 = 1`),
      get: (collectionId) =>
        read(sql`id = ${collectionId}`).pipe(Effect.map(([collection]) => collection ?? null)),
      save: (collection) =>
        Effect.gen(function* () {
          const row = yield* encodeCollection(collection);
          yield* sql`INSERT INTO collections (id, title, fields, primary_key_field_id,
              member_user_ids, column_order, created_at, updated_at)
            VALUES (${row.id}, ${row.title}, ${row.fields}, ${row.primaryKeyFieldId},
              ${row.memberUserIds}, ${row.columnOrder ?? "[]"}, ${row.createdAt}, ${row.updatedAt})
            ON CONFLICT (id) DO UPDATE SET title = excluded.title, fields = excluded.fields,
              primary_key_field_id = excluded.primary_key_field_id,
              member_user_ids = excluded.member_user_ids, column_order = excluded.column_order,
              updated_at = excluded.updated_at`;
        }).pipe(Effect.orDie),
    });
  }),
);
