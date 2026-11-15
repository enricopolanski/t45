/**
 * How a `Layout` shows a set of fields: which columns a table lists, the rows' order, and the
 * fields of a form with how much of a row each takes. Every table and form of a repeatable group's
 * entries or a collection's records resolves its layout here, so they show the same way.
 */
import type * as Schema from "effect/Schema";

import { type Field, holdsData, type Layout } from "./Field.ts";

type TableLayout = NonNullable<Layout["table"]>;
type FormLayout = NonNullable<Layout["form"]>;

/** A URL displayed on another field stays editable in details, without its own table column. */
export const isTableColumn = (field: Field) =>
  field.isDetailOnly !== true && (field.type !== "url" || field.displayLinkOn === undefined);

/**
 * The table `layout` describes for `fields`: its columns, or `defaultColumns` when it lists none,
 * the sort that orders its rows, and its density. Columns and sorts on fields that are gone drop.
 */
export const resolveTableLayout = (
  fields: ReadonlyArray<Field>,
  layout: Layout | undefined,
  defaultColumns: ReadonlyArray<Field> = fields.filter(isTableColumn),
) => {
  const table = layout?.table;
  const columns =
    table?.columns?.flatMap((column) => {
      const field = fields.find((candidate) => candidate.id === column.field);
      return field === undefined
        ? []
        : [
            {
              field,
              header: column.header ?? field.label,
              width: column.width,
              isWrapped: column.isWrapped === true,
            },
          ];
    }) ??
    defaultColumns.map((field) => ({
      field,
      header: field.label,
      width: undefined,
      isWrapped: false,
    }));
  return {
    columns,
    sortBy: (table?.sortBy ?? []).filter((sort) => fields.some((field) => field.id === sort.field)),
    density: table?.density ?? ("normal" as const),
  };
};

export type TableColumn = ReturnType<typeof resolveTableLayout>["columns"][number];

/** How much of a form's row a field takes unless its layout says: text all of it, as it grows. */
const getDefaultSpan = (field: Field): NonNullable<FormLayout["fields"]>[number]["span"] =>
  field.type === "text" ? "full" : field.type === "select" ? "half" : "third";

/**
 * The form `layout` describes for `fields`: those it lists, in its order and spans, then the rest
 * as defined, text last; its spacing, and its dialog width when it sets one.
 */
export const resolveFormLayout = (fields: ReadonlyArray<Field>, layout: Layout | undefined) => {
  const form = layout?.form;
  const listed = (form?.fields ?? []).flatMap((entry) =>
    fields
      .filter((field) => field.id === entry.field)
      .map((field) => ({ field, span: entry.span })),
  );
  const rest = fields.filter((field) => !listed.some((entry) => entry.field === field));
  return {
    fields: [
      ...listed,
      ...[
        ...rest.filter((field) => field.type !== "text"),
        ...rest.filter((field) => field.type === "text"),
      ].map((field) => ({ field, span: getDefaultSpan(field) })),
    ],
    spacing: form?.spacing ?? ("normal" as const),
    dialogWidth: form?.dialogWidth,
  };
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Orders two values that hold data: numbers by size, text by its words and numbers. */
const compareValues = (a: Schema.Json | undefined, b: Schema.Json | undefined) =>
  typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));

/**
 * The rows in the order `sortBy` shows them, empty values last either way and rows equal on every
 * sort in the order they are kept; `valueOf` reads a row's field by id.
 */
export const sortRows = <Row>(
  rows: ReadonlyArray<Row>,
  sortBy: NonNullable<TableLayout["sortBy"]>,
  valueOf: (row: Row, fieldId: string) => Schema.Json | undefined,
) =>
  sortBy.length === 0
    ? rows
    : rows.toSorted((a, b) => {
        for (const { field, direction } of sortBy) {
          const [x, y] = [valueOf(a, field), valueOf(b, field)];
          const order =
            holdsData(x) && holdsData(y)
              ? compareValues(x, y) * (direction === "desc" ? -1 : 1)
              : Number(!holdsData(x)) - Number(!holdsData(y));
          if (order !== 0) return order;
        }
        return 0;
      });
