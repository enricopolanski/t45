import {
  Collection,
  CollectionColumnOrder,
  CollectionExtension,
  CollectionLayout,
} from "@t45/contracts/models/Collection";
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
    isPublished: Schema.BooleanFromBit,
    columnOrder: Schema.optionalKey(Schema.fromJsonString(CollectionColumnOrder)),
    layout: Schema.optionalKey(Schema.fromJsonString(CollectionLayout)),
    extension: Schema.optionalKey(Schema.fromJsonString(CollectionExtension)),
  }),
);

export class CollectionRepository extends Context.Service<
  CollectionRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Collection>>;
    readonly listExtensions: (
      parentCollectionId: string,
    ) => Effect.Effect<ReadonlyArray<Collection>>;
    readonly get: (collectionId: string) => Effect.Effect<Collection | null>;
    readonly save: (collection: Collection) => Effect.Effect<void>;
  }
>()("t45/collections/CollectionRepository") {}

export const layer = Layer.effect(
  CollectionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: Fragment) =>
      sql<{ readonly collection: string }>`SELECT json_patch(json_object(
          'id', id, 'title', title, 'fields', json(fields),
          'primaryKeyFieldId', primary_key_field_id, 'memberUserIds', json(member_user_ids),
          'isPublished', json(CASE WHEN is_published THEN 'true' ELSE 'false' END),
          'columnOrder', json(column_order), 'layout', json(layout),
          'createdAt', created_at, 'updatedAt', updated_at),
          json_object('extension', json(extension))) AS collection
        FROM collections WHERE ${where} ORDER BY title COLLATE NOCASE`.pipe(
        Effect.flatMap((rows) => decodeCollections(rows.map((row) => row.collection))),
        Effect.orDie,
      );

    return CollectionRepository.of({
      list: read(sql`1 = 1`),
      listExtensions: (parentCollectionId) =>
        read(sql`json_extract(extension, '$.parentCollectionId') = ${parentCollectionId}`),
      get: (collectionId) =>
        read(sql`id = ${collectionId}`).pipe(Effect.map(([collection]) => collection ?? null)),
      save: (collection) =>
        Effect.gen(function* () {
          const row = yield* encodeCollection(collection);
          yield* sql`INSERT INTO collections (id, title, fields, primary_key_field_id,
              member_user_ids, is_published, column_order, layout, created_at, updated_at, extension)
            VALUES (${row.id}, ${row.title}, ${row.fields}, ${row.primaryKeyFieldId},
              ${row.memberUserIds}, ${row.isPublished}, ${row.columnOrder ?? "[]"}, ${row.layout ?? "{}"},
              ${row.createdAt}, ${row.updatedAt}, ${row.extension ?? null})
            ON CONFLICT (id) DO UPDATE SET title = excluded.title, fields = excluded.fields,
              primary_key_field_id = excluded.primary_key_field_id,
              member_user_ids = excluded.member_user_ids, column_order = excluded.column_order,
              is_published = excluded.is_published,
              layout = excluded.layout,
              extension = excluded.extension,
              updated_at = excluded.updated_at`;
        }).pipe(Effect.orDie),
    });
  }),
);
