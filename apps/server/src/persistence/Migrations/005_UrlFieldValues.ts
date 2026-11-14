import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * URL fields stored { url, label }; the field definition already supplies the label.
 * Unwrap their values and defaults, including nested and repeated fields. Other field values
 * are scalars or row-id arrays. Preserve every address and the records' freshness timestamps.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, column, id] of [
    ["collections", "fields", "id"],
    ["workflow_versions", "steps", "id"],
    ["collection_records", "field_values", "collection_id"],
    ["tickets", "steps", "id"],
  ] as const) {
    const isRecord = table === "collection_records";
    const values = yield* sql.unsafe<{
      readonly id: string;
      readonly recordKey: string | null;
      readonly path: string;
      readonly url: string;
    }>(`SELECT data.${id} AS id, ${isRecord ? "data.key" : "NULL"} AS recordKey,
        value.fullkey AS path, json_extract(value.value, '$.url') AS url
      FROM ${table} AS data, json_tree(data.${column}) AS value
      WHERE value.type = 'object'
        AND json_type(value.value, '$.url') = 'text'
        AND json_type(value.value, '$.label') = 'text'`);
    for (const value of values) {
      yield* sql.unsafe(
        `UPDATE ${table} SET ${column} = json_set(${column}, ?, ?)
          WHERE ${id} = ?${isRecord ? " AND key = ?" : ""}`,
        [value.path, value.url, value.id, ...(value.recordKey === null ? [] : [value.recordKey])],
      );
    }
  }
});
