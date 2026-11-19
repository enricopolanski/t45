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

type Filters = RecordSearch["filters"];
type RecordPage = RecordSearch & { readonly offset: number; readonly limit: number };
type ValueField = { readonly fieldId: string; readonly linkFieldId?: string };
type CountedValue = { readonly value: string | number; readonly count: number };
type FilterChoice = CountedValue & { readonly link?: string };
type ValueCountRow = CountedValue & { readonly link: string | null };

type SearchRow =
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "matchCount" | "totalCount"; readonly count: number }
  | ({ readonly kind: "choice"; readonly fieldId: string } & ValueCountRow);

export class CollectionRecordRepository extends Context.Service<
  CollectionRecordRepository,
  {
    readonly get: (collectionId: string, key: string) => Effect.Effect<CollectionRecord | null>;
    readonly hasAny: (collectionId: string) => Effect.Effect<boolean>;
    /** A page of matches in key order, with counts and choices for the requested filters. */
    readonly searchPage: (
      search: RecordPage,
      choiceFields: ReadonlyArray<ValueField>,
    ) => Effect.Effect<{
      readonly records: ReadonlyArray<CollectionRecord>;
      readonly matchCount: number;
      readonly totalCount: number;
      readonly filterChoices: Readonly<Record<string, ReadonlyArray<FilterChoice>>>;
    }>;
    /** The distinct values a top-level field holds across the collection, up to 500. */
    readonly listValues: (
      collectionId: string,
      field: ValueField,
    ) => Effect.Effect<ReadonlyArray<FilterChoice>>;
    /** Adds the record, or replaces the values of the one with its key, keeping its creation. */
    readonly save: (record: CollectionRecord) => Effect.Effect<CollectionRecord>;
    /** Reads from one snapshot and commits any writes together. */
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
    const matchFilters = (filters: Filters, value: (fieldId: string) => Fragment) =>
      sql.and(
        Object.entries(filters).flatMap(([fieldId, filter]) =>
          typeof filter === "object"
            ? [
                ...(filter.min === undefined ? [] : [sql`${value(fieldId)} >= ${filter.min}`]),
                ...(filter.max === undefined ? [] : [sql`${value(fieldId)} <= ${filter.max}`]),
              ]
            : [sql`${value(fieldId)} IS json_extract(${JSON.stringify(filter)}, '$')`],
        ),
      );
    const matchText = ({ collectionId, words, fields }: RecordSearch) =>
      sql.and([
        sql`collection_id = ${collectionId}`,
        ...words.map((word) =>
          fields === null
            ? sql`EXISTS (SELECT 1 FROM json_each(field_values) AS value
                WHERE value.type = 'text' AND ${contains(sql`value.value`, word)})`
            : sql.or(fields.map((fieldId) => contains(valueOf(fieldId), word))),
        ),
      ]);
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));
    const count = (where: Fragment) =>
      sql<{ readonly count: number }>`SELECT count(*) AS count FROM collection_records
        WHERE ${where}`.pipe(
        Effect.map(([row]) => row!.count),
        Effect.orDie,
      );
    const queryValueCounts = (
      source: Fragment,
      where: Fragment,
      value: Fragment,
      link: Fragment | undefined,
      selected?: Filters[string],
    ) => {
      const selectedFirst =
        selected === undefined
          ? sql``
          : sql`value IS json_extract(${JSON.stringify(selected)}, '$') DESC,`;
      return sql<ValueCountRow>`SELECT
          ${value} AS value, count(*) AS count, ${link === undefined ? sql`NULL` : sql`min(${link})`} AS link
        FROM ${source}
        WHERE ${where} AND ${value} IS NOT NULL
        GROUP BY value ORDER BY ${selectedFirst} value LIMIT 500`;
    };
    const asChoice = ({ value, count, link }: ValueCountRow): FilterChoice =>
      link === null ? { value, count } : { value, count, link };

    const searchWithChoices = Effect.fnUntraced(function* (
      search: RecordPage,
      choiceFields: ReadonlyArray<ValueField>,
    ) {
      const { collectionId, filters, limit, offset } = search;
      const fields = [...new Map(choiceFields.map((field) => [field.fieldId, field])).values()];
      const projectedFields = new Set(Object.keys(filters));
      for (const { fieldId, linkFieldId } of fields) {
        projectedFields.add(fieldId);
        if (linkFieldId !== undefined) projectedFields.add(linkFieldId);
      }
      const columns = new Map(
        [...projectedFields].map((fieldId, index) => [fieldId, sql`${sql(`field_${index}`)}`]),
      );
      const projectedValue = (fieldId: string) => columns.get(fieldId)!;
      const projection = [...columns].map(
        ([fieldId, column]) => sql`${valueOf(fieldId)} AS ${column}`,
      );
      const choices = fields.map(({ fieldId, linkFieldId }) => {
        // A menu offers replacement values under the other filters.
        const { [fieldId]: selected, ...otherFilters } = filters;
        const counts = queryValueCounts(
          sql`projected`,
          matchFilters(otherFilters, projectedValue),
          projectedValue(fieldId),
          linkFieldId === undefined ? undefined : projectedValue(linkFieldId),
          selected,
        );
        return sql`SELECT 'choice', ${fieldId}, value, count, link FROM (${counts})`;
      });
      const hasCriteria = search.words.length > 0 || Object.keys(filters).length > 0;
      // Read the wide JSON records once. Counts and pagination then use only the projected scalars.
      const rows = yield* sql<SearchRow>`WITH projected AS MATERIALIZED (
          SELECT key, ${sql.csv(projection)} FROM collection_records WHERE ${matchText(search)}
        ), matching_keys AS MATERIALIZED (
          SELECT key FROM projected WHERE ${matchFilters(filters, projectedValue)}
        )
        SELECT 'key' AS kind, NULL AS fieldId, key AS value, NULL AS count, NULL AS link
        FROM (SELECT key FROM matching_keys ORDER BY key LIMIT ${limit} OFFSET ${offset})
        UNION ALL SELECT 'matchCount', NULL, NULL, count(*), NULL FROM matching_keys
        ${
          hasCriteria
            ? sql`UNION ALL SELECT 'totalCount', NULL, NULL, count(*), NULL
          FROM collection_records WHERE collection_id = ${collectionId}`
            : sql``
        }
        UNION ALL ${sql.join(" UNION ALL ", false)(choices)}`.pipe(Effect.orDie);

      const keys: Array<string> = [];
      const filterChoices = new Map(fields.map(({ fieldId }) => [fieldId, [] as FilterChoice[]]));
      let matchCount = 0;
      let totalCount = 0;
      for (const row of rows) {
        switch (row.kind) {
          case "key":
            keys.push(row.value);
            break;
          case "matchCount":
            matchCount = row.count;
            break;
          case "totalCount":
            totalCount = row.count;
            break;
          case "choice":
            filterChoices.get(row.fieldId)!.push(asChoice(row));
        }
      }
      const records =
        keys.length === 0
          ? []
          : yield* read(sql`collection_id = ${collectionId} AND ${sql.in("key", keys)}`);
      return {
        records,
        matchCount,
        totalCount: hasCriteria ? totalCount : matchCount,
        filterChoices: Object.fromEntries(filterChoices),
      };
    });

    return CollectionRecordRepository.of({
      transaction,
      get: (collectionId, key) =>
        read(sql`collection_id = ${collectionId} AND key = ${key}`).pipe(
          Effect.map(([record]) => record ?? null),
        ),
      hasAny: (collectionId) =>
        sql`SELECT 1 FROM collection_records WHERE collection_id = ${collectionId} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      searchPage: (search, choiceFields) =>
        transaction(
          Effect.gen(function* () {
            if (choiceFields.length > 0) return yield* searchWithChoices(search, choiceFields);
            const { collectionId, filters, limit, offset } = search;
            const matching = sql`${matchText(search)} AND ${matchFilters(filters, valueOf)}`;
            const records = yield* read(matching, sql`LIMIT ${limit} OFFSET ${offset}`);
            const matchCount = yield* count(matching);
            const totalCount =
              search.words.length > 0 || Object.keys(filters).length > 0
                ? yield* count(sql`collection_id = ${collectionId}`)
                : matchCount;
            return { records, matchCount, totalCount, filterChoices: {} };
          }),
        ),
      listValues: (collectionId, { fieldId, linkFieldId }) =>
        queryValueCounts(
          sql`collection_records`,
          sql`collection_id = ${collectionId}`,
          valueOf(fieldId),
          linkFieldId === undefined ? undefined : valueOf(linkFieldId),
        ).pipe(
          Effect.map((rows) => rows.map(asChoice)),
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
