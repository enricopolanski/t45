// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import {
  DIGEST_ROWS,
  digestQuery,
  type Encoded,
  keyAlias,
  keyOf,
  placeholder,
  quoteName,
  type TableShape,
  travelling,
} from "../src/persistence/Transfer.ts";

/**
 * Filling an instance's database from another one's rows, before the instance ever starts: while
 * the marker is set the object serves nothing but these calls, so no migration, built-ins or
 * startup work touches a half-loaded database.
 */
const IMPORTING = "importing";
const progressKey = (table: string) => `import:${table}`;

export const isImporting = (storage: DurableObjectStorage) =>
  storage.kv.get(IMPORTING) !== undefined;

export type TransferRequest =
  | { readonly op: "begin"; readonly tables: ReadonlyArray<TableShape> }
  | {
      readonly op: "rows";
      readonly table: TableShape;
      readonly rows: ReadonlyArray<ReadonlyArray<Encoded>>;
    }
  | {
      readonly op: "finish";
      readonly ddl: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
    }
  | {
      readonly op: "verify";
      readonly table: TableShape;
      readonly after: ReadonlyArray<Encoded> | null;
    }
  | { readonly op: "activate" };

/** As the object binds an encoded value. */
export const bound = (value: Encoded): Array<unknown> => {
  if (value === null) return [];
  if (typeof value === "string" || typeof value === "number") return [value];
  if (value[0] === "i") return [value[1]];
  const bytes = NodeBuffer.Buffer.from(value[1], "base64");
  return [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)];
};

/** A key value read back from SQLite, as it travels. */
const encodeKey = (value: unknown): Encoded => {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? ["i", String(value)] : value;
  if (value instanceof ArrayBuffer) return ["b", NodeBuffer.Buffer.from(value).toString("base64")];
  throw new Error(`Unexpected key value ${String(value)}`);
};

/** The instance's tables: not SQLite's, Cloudflare's, nor the one `wrangler dev` names objects in. */
const userTables = (sql: SqlStorage) =>
  sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
        AND name != '__miniflare_do_name'`,
    )
    .toArray()
    .map((row) => row.name);

export const transfer = (storage: DurableObjectStorage, request: TransferRequest) => {
  const sql = storage.sql;
  switch (request.op) {
    case "begin": {
      if (!isImporting(storage)) {
        const existing = userTables(sql);
        if (existing.length > 0)
          throw new Error(`This instance already has a database: ${existing.join(", ")}.`);
        storage.kv.put(IMPORTING, true);
        // Rows arrive table by table, children possibly before their parents; checked at the end.
        sql.exec("PRAGMA foreign_keys = OFF");
        storage.transactionSync(() => {
          for (const table of request.tables) sql.exec(table.sql);
        });
      }
      return {
        progress: Object.fromEntries(
          request.tables.map((table) => [
            table.name,
            storage.kv.get(progressKey(table.name)) ?? null,
          ]),
        ),
      };
    }
    case "rows": {
      if (!isImporting(storage)) throw new Error("No import is in progress.");
      const { table, rows } = request;
      const columns = travelling(table).map(quoteName).join(", ");
      sql.exec("PRAGMA foreign_keys = OFF");
      storage.transactionSync(() => {
        for (const row of rows)
          sql.exec(
            `INSERT INTO ${quoteName(table.name)} (${columns}) VALUES (${row.map(placeholder).join(", ")})`,
            ...row.flatMap(bound),
          );
        const last = rows.at(-1);
        // Kept with the rows, so a batch is never loaded twice.
        if (last !== undefined) storage.kv.put(progressKey(table.name), keyOf(table, last));
      });
      return { inserted: rows.length };
    }
    case "finish": {
      sql.exec("PRAGMA foreign_keys = ON");
      const existing = new Set(
        sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master")
          .toArray()
          .map((row) => row.name),
      );
      // Those a rerun already created stay.
      storage.transactionSync(() => {
        for (const { name, sql: statement } of request.ddl)
          if (!existing.has(name)) sql.exec(statement);
      });
      return { foreignKeyErrors: sql.exec("PRAGMA foreign_key_check").toArray().length };
    }
    case "verify": {
      const { table, after } = request;
      const hash = NodeCrypto.createHash("sha256");
      let count = 0;
      let last: Array<Encoded> | null = null;
      const cursor = sql.exec(
        digestQuery(table, after),
        ...(after ?? []).flatMap(bound),
        DIGEST_ROWS,
      );
      for (const row of cursor) {
        hash.update(`${String(row["row_text"])}\n`);
        count += 1;
        last = table.key.map((_name, index) => encodeKey(row[keyAlias(index)]));
      }
      return { count, digest: hash.digest("hex"), last };
    }
    case "activate": {
      for (const name of userTables(sql)) storage.kv.delete(progressKey(name));
      storage.kv.delete(IMPORTING);
      return { activated: true };
    }
  }
};
