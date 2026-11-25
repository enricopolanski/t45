/**
 * How a `Layout` shows a set of fields: which columns a table lists, the rows' order, and the
 * fields of a form with how much of a row each takes. Every table and form of a repeatable group's
 * entries or a collection's records resolves its layout here, so they show the same way.
 */
import type * as Schema from "effect/Schema";

import type { Collection } from "./Collection.ts";
import {
  type Field,
  type FieldValues,
  groupRows,
  holdsData,
  type Layout,
  UPDATED_AT_COLUMN,
} from "./Field.ts";

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

type RecordShape = Pick<Collection, "fields" | "primaryKeyFieldId" | "columnOrder">;

/** Every column of the records table in the column order, the last update included. */
export const listColumnOrder = (collection: RecordShape) => [
  ...new Set([
    ...(collection.columnOrder ?? []),
    ...collection.fields.map((field) => field.id),
    UPDATED_AT_COLUMN,
  ]),
];

/**
 * The fields the records table lists when its layout lists none, in the column order: the primary
 * key always, and each field shown in the table but a group that neither repeats nor shows a link.
 */
export const listDefaultColumns = (collection: RecordShape) =>
  listColumnOrder(collection).flatMap((id) =>
    collection.fields.filter(
      (field) =>
        field.id === id &&
        (field.id === collection.primaryKeyFieldId ||
          (isTableColumn(field) &&
            (field.type !== "group" ||
              field.repeatable ||
              collection.fields.some(
                (source) => source.type === "url" && source.displayLinkOn === field.id,
              )))),
    ),
  );

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

/** A field that can show a record's images: a file field, or a group holding one. */
const canHoldImages = (field: Field) =>
  field.type === "file" ||
  (field.type === "group" && field.fields.some((inner) => inner.type === "file"));

/** A field whose value reads on one line, as a card's or page's title, highlight or extra lines. */
const isOneLine = (field: Field) =>
  !["group", "file", "records"].includes(field.type) &&
  (field.type !== "text" || field.isMarkdown !== true);

/**
 * How `collection`'s records show as cards and each on its own page: the fields playing each part,
 * those of the wrong type or gone dropped, and the cards' and page's settings. Without a display,
 * the first field that can hold images shows them; the primary key titles a record without a title.
 */
export const resolveRecordDisplay = ({
  fields,
  primaryKeyFieldId,
  layout,
}: Pick<Collection, "fields" | "primaryKeyFieldId" | "layout">) => {
  const display = layout?.display;
  const findField = (id: string | undefined, isFit: (field: Field) => boolean) =>
    fields.find((field) => field.id === id && isFit(field));
  const listFields = (ids: ReadonlyArray<string> | undefined, isFit: (field: Field) => boolean) =>
    (ids ?? []).flatMap((id) => fields.filter((field) => field.id === id && isFit(field)));
  return {
    image:
      display === undefined ? fields.find(canHoldImages) : findField(display.image, canHoldImages),
    title: findField(display?.title, isOneLine) ?? findField(primaryKeyFieldId, isOneLine),
    subtitle: findField(display?.subtitle, isOneLine),
    highlight: findField(display?.highlight, isOneLine),
    badges: listFields(display?.badges, (field) => field.type === "select"),
    extra: listFields(layout?.cards?.extra, isOneLine),
    size: layout?.cards?.size ?? ("medium" as const),
    imageRatio: layout?.cards?.imageRatio ?? ("square" as const),
    imageFit: layout?.cards?.imageFit ?? ("contain" as const),
    template: layout?.page?.template ?? ("form" as const),
    defaultView: layout?.defaultView ?? ("table" as const),
  };
};

/** A field a search looks in: one whose value reads as text. */
export const isSearchable = (field: Field) =>
  ["text", "url", "select", "number", "date"].includes(field.type);

/** A field a filter picks a value or a range of: Markdown text runs too long to pick. */
export const isFilterable = (field: Field) =>
  ["select", "boolean", "number", "date"].includes(field.type) ||
  (field.type === "text" && field.isMarkdown !== true);

/**
 * How people find `collection`'s records: the fields a search looks in, null for every text value
 * when its layout names none that are left, and the filters shown above them, in order.
 */
export const resolveRecordSearch = ({ fields, layout }: Pick<Collection, "fields" | "layout">) => {
  const listFields = (ids: ReadonlyArray<string>, isFit: (field: Field) => boolean) =>
    ids.flatMap((id) => fields.filter((field) => field.id === id && isFit(field)));
  const searched = listFields(layout?.search?.fields ?? [], isSearchable);
  const filters = layout?.search?.filters ?? [];
  return {
    fields: searched.length === 0 ? null : searched,
    filters: listFields(
      filters.map(({ field }) => field),
      isFilterable,
    ),
    /** The URL field whose site icon each filter's values show, by filter field. */
    iconLinks: Object.fromEntries(
      filters.flatMap(({ field, iconLink }) => (iconLink === undefined ? [] : [[field, iconLink]])),
    ) as Readonly<Record<string, string>>,
  };
};

/** The files `field` holds in `values`, a group's in the order of its rows. */
export const listFieldFiles = (field: Field, values: FieldValues) => {
  const file =
    field.type === "file"
      ? field
      : field.type === "group"
        ? field.fields.find((inner) => inner.type === "file")
        : undefined;
  if (file === undefined) return [];
  const paths =
    field === file
      ? [field.id]
      : groupRows(field, values[field.id]).map((row) =>
          row === null ? `${field.id}.${file.id}` : `${field.id}.${row}.${file.id}`,
        );
  return paths.flatMap((path) => {
    const value = values[path];
    return typeof value === "string" ? [value] : [];
  });
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
