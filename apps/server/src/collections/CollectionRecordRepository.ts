import { CollectionRecord, type RecordFilters } from "@t45/contracts/models/Collection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const decodeRecords = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(CollectionRecord)),
);
const encodeRecord = Schema.encodeEffect(
  Schema.Struct({
    ...CollectionRecord.fields,
    values: Schema.fromJsonString(CollectionRecord.fields.values),
  }),
);

/** Which records a search finds: all must hold. */
export interface RecordSearch {
  readonly collectionId: string;
  /** Words that each appear, ignoring case, in one of `fields`, or of the text values when null. */
  readonly words: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<string> | null;
  /** Values top-level fields hold exactly, or ranges they lie within, by field id. */
  readonly filters: typeof RecordFilters.Type;
}

export class CollectionRecordRepository extends Context.Service<
  CollectionRecordRepository,
  {
    readonly get: (collectionId: string, key: string) => Effect.Effect<CollectionRecord | null>;
    readonly hasAny: (collectionId: string) => Effect.Effect<boolean>;
    /** The matching records in key order, `limit` of them from `offset`. */
    readonly search: (
      search: RecordSearch & { readonly offset: number; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<CollectionRecord>>;
    /** How many records match. */
    readonly count: (search: RecordSearch) => Effect.Effect<number>;
    /** The distinct values a top-level field holds, in order, up to 500. */
    readonly listValues: (
      collectionId: string,
      fieldId: string,
    ) => Effect.Effect<ReadonlyArray<string | number>>;
    /** Adds the record, or replaces the values of the one with its key, keeping its creation. */
    readonly save: (record: CollectionRecord) => Effect.Effect<CollectionRecord>;
    /** Commits a record's write together with the file ownership changes it makes. */
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t45/collections/CollectionRecordRepository") {}

export const layer = Layer.effect(
  CollectionRecordRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const recordJson = sql.literal(`json_object('collectionId', collection_id, 'key', key,
      'values', json(field_values), 'createdAt', created_at, 'updatedAt', updated_at)`);
    const read = (where: Fragment, rest: Fragment = sql``) =>
      sql<{ readonly record: string }>`SELECT ${recordJson} AS record
        FROM collection_records WHERE ${where} ORDER BY key ${rest}`.pipe(
        Effect.flatMap((rows) => decodeRecords(rows.map((row) => row.record))),
        Effect.orDie,
      );

    const valueOf = (fieldId: string) => sql`json_extract(field_values, ${`$."${fieldId}"`})`;
    const contains = (value: Fragment, word: string) =>
      sql`instr(lower(CAST(${value} AS TEXT)), lower(${word})) > 0`;
    const matching = ({ collectionId, words, fields, filters }: RecordSearch) =>
      sql.and([
        sql`collection_id = ${collectionId}`,
        ...Object.entries(filters).flatMap(([fieldId, filter]) =>
          typeof filter === "object"
            ? [
                ...(filter.min === undefined ? [] : [sql`${valueOf(fieldId)} >= ${filter.min}`]),
                ...(filter.max === undefined ? [] : [sql`${valueOf(fieldId)} <= ${filter.max}`]),
              ]
            : [sql`${valueOf(fieldId)} IS json_extract(${JSON.stringify(filter)}, '$')`],
        ),
        ...words.map((word) =>
          fields === null
            ? sql`EXISTS (SELECT 1 FROM json_each(field_values) AS value
                WHERE value.type = 'text' AND ${contains(sql`value.value`, word)})`
            : sql.or(fields.map((fieldId) => contains(valueOf(fieldId), word))),
        ),
      ]);

    return CollectionRecordRepository.of({
      transaction: (effect) =>
        sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die })),
      get: (collectionId, key) =>
        read(sql`collection_id = ${collectionId} AND key = ${key}`).pipe(
          Effect.map(([record]) => record ?? null),
        ),
      hasAny: (collectionId) =>
        sql`SELECT 1 FROM collection_records WHERE collection_id = ${collectionId} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      search: ({ offset, limit, ...search }) =>
        read(matching(search), sql`LIMIT ${limit} OFFSET ${offset}`),
      count: (search) =>
        sql<{ readonly count: number }>`SELECT count(*) AS count FROM collection_records
          WHERE ${matching(search)}`.pipe(
          Effect.map(([row]) => row?.count ?? 0),
          Effect.orDie,
        ),
      listValues: (collectionId, fieldId) =>
        sql<{ readonly value: string | number }>`SELECT DISTINCT
            json_extract(field_values, ${`$."${fieldId}"`}) AS value
          FROM collection_records
          WHERE collection_id = ${collectionId} AND value IS NOT NULL
          ORDER BY value LIMIT 500`.pipe(
          Effect.map((rows) => rows.map((row) => row.value)),
          Effect.orDie,
        ),
      save: (record) =>
        Effect.gen(function* () {
          const row = yield* encodeRecord(record);
          const [saved] = yield* sql<{ readonly record: string }>`INSERT INTO collection_records
              (collection_id, key, field_values, created_at, updated_at)
            VALUES (${row.collectionId}, ${row.key}, ${row.values}, ${row.createdAt},
              ${row.updatedAt})
            ON CONFLICT (collection_id, key) DO UPDATE SET field_values = excluded.field_values,
              updated_at = excluded.updated_at
            RETURNING ${recordJson} AS record`;
          return (yield* decodeRecords([saved!.record]))[0]!;
        }).pipe(Effect.orDie),
    });
  }),
);
