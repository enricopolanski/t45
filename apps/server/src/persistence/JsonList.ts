import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * A list as one JSON array, for a statement to read with `json_each`: its parameter count then
 * doesn't grow with the list, and a Durable Object takes at most 100 parameters per statement.
 */
export const jsonList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** `column IN (values)`, the values bound as one JSON array. */
export const inJsonList = (
  sql: SqlClient.SqlClient,
  column: string,
  values: ReadonlyArray<string>,
) => sql`${sql(column)} IN (SELECT value FROM json_each(${jsonList(values)}))`;
