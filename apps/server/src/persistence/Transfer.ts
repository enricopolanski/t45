/**
 * Moving an instance's SQLite database, row by row, between a Node file and a Durable Object.
 * Both ends keep each value's storage class: JSON numbers only carry reals, so integers travel as
 * decimal strings and blobs as base64.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import type * as NodeSqlite from "node:sqlite";

/** One SQLite value in transit. */
export type Encoded = null | string | number | readonly ["i", string] | readonly ["b", string];

/** A table as its source declares it; `rowid` tables travel with their rowids, in rowid order. */
export interface TableShape {
  readonly name: string;
  readonly sql: string;
  readonly columns: ReadonlyArray<string>;
  /** `["rowid"]`, or a WITHOUT ROWID table's primary key, in order. */
  readonly key: ReadonlyArray<string>;
}

export const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The columns a row of `table` travels with: its rowid first when it has one. */
export const travelling = (table: TableShape) =>
  table.key[0] === "rowid" ? ["rowid", ...table.columns] : table.columns;

/** The key of a travelling row of `table`. */
export const keyOf = (table: TableShape, row: ReadonlyArray<Encoded>) => {
  const columns = travelling(table);
  return table.key.map((name) => row[columns.indexOf(name)] ?? null);
};

/** A value's rough size in transit, for sizing batches. */
export const sizeOf = (value: Encoded) =>
  value === null
    ? 4
    : typeof value === "number"
      ? 8
      : typeof value === "string"
        ? value.length
        : value[1].length;

/** As a Node database binds an encoded value: integers as decimal text, which the query casts back. */
export const bindable = (value: Encoded): NodeSqlite.SQLInputValue | undefined => {
  if (value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return value;
  return value[0] === "i" ? value[1] : NodeBuffer.Buffer.from(value[1], "base64");
};

/**
 * A database's tables, and its indexes, views and triggers to create once the rows are in, read
 * with `query` on either end. SQLite's own tables, Cloudflare's, and the one `wrangler dev` names
 * objects in stay behind.
 */
export const shapesOf = (query: (sql: string) => ReadonlyArray<Record<string, unknown>>) => {
  const entries = query(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
      AND name != '__miniflare_do_name'`,
  ) as ReadonlyArray<{ type: string; name: string; sql: string }>;
  const tables = entries
    .filter((entry) => entry.type === "table")
    .map((entry): TableShape => {
      const info = query(`PRAGMA table_info(${quoteName(entry.name)})`) as ReadonlyArray<{
        name: string;
        pk: number;
      }>;
      const withoutRowid = /WITHOUT\s+ROWID\s*$/iu.test(entry.sql.trim());
      const key = withoutRowid
        ? info
            .filter((column) => column.pk > 0)
            .toSorted((a, b) => a.pk - b.pk)
            .map((column) => column.name)
        : ["rowid"];
      return { name: entry.name, sql: entry.sql, columns: info.map((column) => column.name), key };
    });
  // Indexes before views, views before the triggers that may read them, each in the source's order.
  const order = ["index", "view", "trigger"];
  const ddl = entries
    .filter((entry) => entry.type !== "table")
    .toSorted((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    .map(({ name, sql }) => ({ name, sql }));
  return { tables, ddl };
};

/** A bound parameter's placeholder: an integer is cast back from its decimal string. */
export const placeholder = (value: Encoded) =>
  value === null ? "NULL" : Array.isArray(value) && value[0] === "i" ? "CAST(? AS INTEGER)" : "?";

/**
 * Text that pins down one row exactly, storage class included, computed by SQLite at both ends:
 * equal digests over the same key order mean equal tables.
 */
const rowTextSql = (table: TableShape) =>
  travelling(table)
    .map((column) => `typeof(${quoteName(column)}) || ':' || quote(${quoteName(column)})`)
    .join(` || '|' || `);

/** Where a digested row's key column `index` is read: SQLite names a selected rowid after its alias. */
export const keyAlias = (index: number) => `key_${index}`;

/** The rows after `after` in key order, as their row text and key: what both ends digest. */
export const digestQuery = (table: TableShape, after: ReadonlyArray<Encoded> | null) => {
  const key = table.key.map(quoteName);
  const where =
    after === null ? "" : `WHERE (${key.join(", ")}) > (${after.map(placeholder).join(", ")})`;
  const keyColumns = key.map((column, index) => `${column} AS ${keyAlias(index)}`).join(", ");
  return `SELECT ${rowTextSql(table)} AS row_text, ${keyColumns}
    FROM ${quoteName(table.name)} ${where} ORDER BY ${key.join(", ")} LIMIT ?`;
};

/** How many rows a verification step digests per call. */
export const DIGEST_ROWS = 20_000;
