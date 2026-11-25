/**
 * Moving an instance's SQLite database, row by row, between a Node file and a Durable Object.
 * Both ends keep each value's storage class: JSON numbers only carry reals, so integers travel as
 * decimal strings and blobs as base64.
 */

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
