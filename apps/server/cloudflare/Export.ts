// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import {
  type Encoded,
  placeholder,
  quoteName,
  shapesOf,
  sizeOf,
  type TableShape,
  travelling,
} from "../src/persistence/Transfer.ts";
import { bound } from "./Import.ts";

/**
 * Reading an instance's database out, page by page, for `scripts/backup-cloudflare-to-r2.ts`. It
 * only reads, so the instance keeps serving meanwhile.
 */
export type ExportRequest =
  | { readonly op: "schema" }
  | {
      readonly op: "rows";
      readonly table: TableShape;
      readonly after: ReadonlyArray<Encoded> | null;
    };

/** A page's rough size; a single larger row travels alone. */
const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 5000;

/** A value read back with its storage class: integers come as decimal text, blobs as bytes. */
const encode = (type: unknown, value: unknown): Encoded => {
  if (type === "integer") return ["i", String(value)];
  if (type === "blob")
    return ["b", NodeBuffer.Buffer.from(value as ArrayBuffer).toString("base64")];
  return value as Encoded;
};

export const exportDatabase = async (
  storage: DurableObjectStorage,
  instance: string,
  request: ExportRequest,
) => {
  const sql = storage.sql;
  if (request.op === "schema")
    return {
      instance,
      ...shapesOf((query) => sql.exec(query).toArray()),
      databaseSize: sql.databaseSize,
      // Point-in-time recovery restores the object as of this bookmark, for 30 days.
      bookmark: await storage.getCurrentBookmark(),
    };
  const { table, after } = request;
  const columns = travelling(table);
  const key = table.key.map(quoteName).join(", ");
  const where = after === null ? "" : `WHERE (${key}) > (${after.map(placeholder).join(", ")})`;
  const selected = columns.map((column, index) => {
    const name = quoteName(column);
    return `typeof(${name}) AS t${index}, CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT) ELSE ${name} END AS v${index}`;
  });
  const cursor = sql.exec(
    `SELECT ${selected.join(", ")} FROM ${quoteName(table.name)} ${where} ORDER BY ${key} LIMIT ?`,
    ...(after ?? []).flatMap(bound),
    PAGE_ROWS,
  );
  const rows: Array<Array<Encoded>> = [];
  let bytes = 0;
  for (const row of cursor) {
    const encoded = columns.map((_column, index) => encode(row[`t${index}`], row[`v${index}`]));
    rows.push(encoded);
    bytes += encoded.reduce((sum: number, value) => sum + sizeOf(value), 0);
    if (bytes >= PAGE_BYTES) break;
  }
  return { rows };
};
