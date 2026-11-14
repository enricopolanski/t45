import { CollectionRecord } from "@t45/contracts/models/Collection";
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

/** Which records a search returns: all must hold. */
export interface RecordSearch {
  readonly collectionId: string;
  /** Text one of a record's text values contains, ignoring case. */
  readonly text: string | null;
  /** Values top-level fields hold exactly, by field id. */
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  readonly offset: number;
  readonly limit: number;
}

export class CollectionRecordRepository extends Context.Service<
  CollectionRecordRepository,
  {
    readonly get: (collectionId: string, key: string) => Effect.Effect<CollectionRecord | null>;
    readonly hasAny: (collectionId: string) => Effect.Effect<boolean>;
    /** The matching records in key order, up to `limit`. */
    readonly search: (search: RecordSearch) => Effect.Effect<ReadonlyArray<CollectionRecord>>;
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
      search: ({ collectionId, text, filters, offset, limit }) =>
        read(
          sql.and([
            sql`collection_id = ${collectionId}`,
            ...Object.entries(filters).map(
              ([fieldId, value]) =>
                sql`json_extract(field_values, ${`$."${fieldId}"`}) IS json_extract(${JSON.stringify(value)}, '$')`,
            ),
            ...(text === null
              ? []
              : [
                  sql`EXISTS (SELECT 1 FROM json_each(field_values) AS value
                    WHERE value.type = 'text' AND instr(lower(value.value), lower(${text})) > 0)`,
                ]),
          ]),
          sql`LIMIT ${limit} OFFSET ${offset}`,
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
