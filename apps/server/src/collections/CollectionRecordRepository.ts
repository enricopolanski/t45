import { CollectionRecord, type RecordFilters } from "@t45/contracts/models/Collection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

import { inJsonList } from "../persistence/JsonList.ts";

const decodeRecords = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(CollectionRecord)),
);
const decodeRecordList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CollectionRecord)),
);
/** A menu's choices, as `[value, count, link]` in the order the search sorted them. */
const decodeChoices = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Tuple([
        Schema.Union([Schema.String, Schema.Number]),
        Schema.Number,
        Schema.NullOr(Schema.String),
      ]),
    ),
  ),
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
  /** The top-level fields holding lists: a filter matches one of their items. */
  readonly listFieldIds: ReadonlyArray<string>;
}

type Filters = RecordSearch["filters"];
type RecordPage = RecordSearch & { readonly offset: number; readonly limit: number };
type ValueField = {
  readonly fieldId: string;
  readonly linkFieldId?: string;
  /** Whether the field holds a list, whose items are counted. */
  readonly isList?: boolean;
};
type CountedValue = { readonly value: string | number; readonly count: number };
type FilterChoice = CountedValue & { readonly link?: string };
type ValueCountRow = CountedValue & { readonly link: string | null };

export class CollectionRecordRepository extends Context.Service<
  CollectionRecordRepository,
  {
    readonly get: (collectionId: string, key: string) => Effect.Effect<CollectionRecord | null>;
    readonly listByKeys: (
      collectionId: string,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<CollectionRecord>>;
    readonly observeChanges: (
      onChange: (collectionId: string, key: string) => void,
    ) => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly hasAny: (collectionId: string) => Effect.Effect<boolean>;
    /** Whether any record holds a value of the top-level field, or within it for a group. */
    readonly holdsField: (collectionId: string, fieldId: string) => Effect.Effect<boolean>;
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
    /** The distinct values a top-level field holds across the collection, up to 500; a list's items. */
    readonly listValues: (
      collectionId: string,
      field: ValueField,
    ) => Effect.Effect<ReadonlyArray<FilterChoice>>;
    /** Adds the record, or replaces the values of the one with its key, keeping its creation. */
    readonly save: (record: CollectionRecord) => Effect.Effect<CollectionRecord>;
    readonly remove: (collectionId: string, key: string) => Effect.Effect<void>;
    /** Reads from one snapshot and commits any writes together. */
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t45/collections/CollectionRecordRepository") {}

export const layer = Layer.effect(
  CollectionRecordRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const observers = new Set<(collectionId: string, key: string) => void>();
    const publishChange = (collectionId: string, key: string) =>
      sql.afterCommit(
        Effect.sync(() => {
          for (const observer of observers) observer(collectionId, key);
        }),
      );
    const recordJson = sql.literal(`json_object('collectionId', collection_id, 'key', key,
      'values', json(field_values), 'createdAt', created_at, 'updatedAt', updated_at)`);
    const read = (where: Fragment) =>
      sql<{ readonly record: string }>`SELECT ${recordJson} AS record
        FROM collection_records WHERE ${where}`.pipe(
        Effect.flatMap((rows) => decodeRecords(rows.map((row) => row.record))),
        Effect.orDie,
      );

    const valueOf = (fieldId: string) => sql`json_extract(field_values, ${`$."${fieldId}"`})`;
    const contains = (value: Fragment, word: string) =>
      sql`instr(lower(CAST(${value} AS TEXT)), lower(${word})) > 0`;
    const matchFilters = (
      filters: Filters,
      value: (fieldId: string) => Fragment,
      listFieldIds: ReadonlyArray<string>,
    ) =>
      sql.and(
        Object.entries(filters).flatMap(([fieldId, filter]) => {
          if (typeof filter === "object")
            return [
              ...(filter.min === undefined ? [] : [sql`${value(fieldId)} >= ${filter.min}`]),
              ...(filter.max === undefined ? [] : [sql`${value(fieldId)} <= ${filter.max}`]),
            ];
          const wanted = sql`json_extract(${JSON.stringify(filter)}, '$')`;
          return listFieldIds.includes(fieldId)
            ? [sql`EXISTS (SELECT 1 FROM json_each(${value(fieldId)}) WHERE value IS ${wanted})`]
            : [sql`${value(fieldId)} IS ${wanted}`];
        }),
      );
    /** Where a field's values are counted from: a list's items, each its own value. */
    const countedValues = (source: Fragment, value: Fragment, isList: boolean) =>
      isList
        ? { source: sql`${source}, json_each(${value}) AS item`, value: sql`item.value` }
        : { source, value };
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
    const searchSource = (collectionId: string, fields: ReadonlyArray<string> | null) => {
      if (fields === null) return sql`collection_records`;
      const missingFields = sql`
        SELECT value FROM json_each(${JSON.stringify(fields)})
        EXCEPT SELECT field_id FROM collection_search_fields WHERE collection_id = ${collectionId}
      `;
      // Coverage and record values must be read from the same layout snapshot.
      return sql`(
        SELECT collection_id, key, field_values FROM collection_record_search
        WHERE collection_id = ${collectionId} AND NOT EXISTS (${missingFields})
        UNION ALL
        SELECT collection_id, key, field_values FROM collection_records
        WHERE collection_id = ${collectionId} AND EXISTS (${missingFields})
      )`;
    };
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

    const searchPage = Effect.fnUntraced(function* (
      search: RecordPage,
      choiceFields: ReadonlyArray<ValueField>,
    ) {
      const { collectionId, filters, listFieldIds, limit, offset } = search;
      const fields = [...new Map(choiceFields.map((field) => [field.fieldId, field])).values()];
      const filterIds = Object.keys(filters);
      const hasCriteria = search.words.length > 0 || filterIds.length > 0;
      const inCollection = sql`collection_id = ${collectionId}`;
      const projectedFields = new Set(filterIds);
      for (const { fieldId, linkFieldId } of fields) {
        projectedFields.add(fieldId);
        if (linkFieldId !== undefined) projectedFields.add(linkFieldId);
      }
      const source = searchSource(
        collectionId,
        search.words.length === 0
          ? [...projectedFields]
          : search.fields === null
            ? null
            : [...projectedFields, ...search.fields],
      );
      const ctes: Array<Fragment> = [];
      const choices: Array<Fragment> = [];
      let matching = hasCriteria
        ? sql`SELECT key FROM ${source}
            WHERE ${matchText(search)} AND ${matchFilters(filters, valueOf, listFieldIds)}`
        : sql`SELECT key FROM collection_records WHERE ${inCollection}`;

      if (fields.length > 0) {
        const columns = new Map(
          [...projectedFields].map((fieldId, index) => [fieldId, sql`${sql(`field_${index}`)}`]),
        );
        const projectedValue = (fieldId: string) => columns.get(fieldId)!;
        const projection = [...columns].map(
          ([fieldId, column]) => sql`${valueOf(fieldId)} AS ${column}`,
        );
        // Menus share one projection of their fields. Only a filtered page needs those record keys.
        ctes.push(sql`projected AS MATERIALIZED (
          SELECT ${hasCriteria ? sql`key,` : sql``} ${sql.csv(projection)}
          FROM ${source} WHERE ${matchText(search)}
        )`);
        if (hasCriteria) {
          matching = sql`SELECT key FROM projected
            WHERE ${matchFilters(filters, projectedValue, listFieldIds)}`;
        }
        for (const { fieldId, linkFieldId } of fields) {
          // A menu offers replacement values under the other filters.
          const { [fieldId]: selected, ...otherFilters } = filters;
          const counted = countedValues(
            sql`projected`,
            projectedValue(fieldId),
            listFieldIds.includes(fieldId),
          );
          const counts = queryValueCounts(
            counted.source,
            matchFilters(otherFilters, projectedValue, listFieldIds),
            counted.value,
            linkFieldId === undefined ? undefined : projectedValue(linkFieldId),
            selected,
          );
          choices.push(
            sql`, (SELECT json_group_array(json_array(value, count, link)) FROM (${counts}))
              AS ${sql(`choices_${choices.length}`)}`,
          );
        }
      }

      // Reuse filtered matches for the page and its count. An unfiltered page can
      // take both directly from the covering index.
      if (hasCriteria) {
        ctes.push(sql`matching_keys AS MATERIALIZED (${matching})`);
        matching = sql`SELECT key FROM matching_keys`;
      }
      ctes.push(sql`page AS (${matching} ORDER BY key LIMIT ${limit} OFFSET ${offset})`);
      const matchSource = hasCriteria
        ? sql`matching_keys`
        : sql`collection_records WHERE ${inCollection}`;
      // A single read statement keeps page, counts and menus on one SQLite snapshot. Each part is a
      // column of its own, not a UNION ALL term: a Durable Object allows five terms per compound SELECT.
      const [row] = yield* sql<{
        readonly records: string;
        readonly matchCount: number;
        readonly totalCount: number | null;
        readonly [choices: `choices_${number}`]: string;
      }>`WITH ${sql.csv(ctes)}
        SELECT
          (SELECT json_group_array(json(record)) FROM (SELECT ${recordJson} AS record
            FROM collection_records
            WHERE ${inCollection} AND key IN (SELECT key FROM page) ORDER BY key)) AS records,
          (SELECT count(*) FROM ${matchSource}) AS "matchCount",
          ${
            hasCriteria
              ? sql`(SELECT count(*) FROM collection_records WHERE ${inCollection})`
              : sql`NULL`
          } AS "totalCount"
        ${sql.join(" ", false)(choices)}`;
      const matchCount = row?.matchCount ?? 0;
      const filterChoices: Record<string, ReadonlyArray<FilterChoice>> = {};
      for (const [index, { fieldId }] of fields.entries()) {
        const counted = yield* decodeChoices(row?.[`choices_${index}`] ?? "[]");
        filterChoices[fieldId] = counted.map(([value, count, link]) =>
          asChoice({ value, count, link }),
        );
      }
      return {
        records: yield* decodeRecordList(row?.records ?? "[]"),
        matchCount,
        totalCount: hasCriteria ? (row?.totalCount ?? 0) : matchCount,
        filterChoices,
      };
    }, Effect.orDie);

    return CollectionRecordRepository.of({
      transaction,
      listByKeys: (collectionId, keys) =>
        keys.length === 0
          ? Effect.succeed([])
          : read(sql`collection_id = ${collectionId} AND ${inJsonList(sql, "key", keys)}`),
      observeChanges: (observe) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            observers.add(observe);
          }),
          () =>
            Effect.sync(() => {
              observers.delete(observe);
            }),
        ),
      get: (collectionId, key) =>
        read(sql`collection_id = ${collectionId} AND key = ${key}`).pipe(
          Effect.map(([record]) => record ?? null),
        ),
      hasAny: (collectionId) =>
        sql`SELECT 1 FROM collection_records WHERE collection_id = ${collectionId} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      // A group's values sit under dotted keys: "group.child", "group.row.child".
      holdsField: (collectionId, fieldId) =>
        sql`SELECT 1 FROM collection_records, json_each(field_values) AS entry
            WHERE collection_id = ${collectionId}
              AND (entry.key = ${fieldId} OR instr(entry.key, ${`${fieldId}.`}) = 1)
            LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      searchPage,
      listValues: (collectionId, { fieldId, linkFieldId, isList = false }) => {
        const source = searchSource(
          collectionId,
          linkFieldId === undefined ? [fieldId] : [fieldId, linkFieldId],
        );
        const counted = countedValues(source, valueOf(fieldId), isList);
        return queryValueCounts(
          counted.source,
          sql`collection_id = ${collectionId}`,
          counted.value,
          linkFieldId === undefined ? undefined : valueOf(linkFieldId),
        ).pipe(
          Effect.map((rows) => rows.map(asChoice)),
          Effect.orDie,
        );
      },
      remove: (collectionId, key) =>
        sql`DELETE FROM collection_records WHERE collection_id = ${collectionId} AND key = ${key}`.pipe(
          Effect.andThen(publishChange(collectionId, key)),
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
          const decoded = (yield* decodeRecords([saved!.record]))[0]!;
          yield* publishChange(record.collectionId, record.key);
          return decoded;
        }).pipe(Effect.orDie),
    });
  }),
);
