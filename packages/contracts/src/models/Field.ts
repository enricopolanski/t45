/**
 * A `Field` is one value a form holds, such as a workflow step's or a collection record's: its
 * label, its type and the value it takes. Values are kept by dotted key: a field inside a group is
 * `group.field`, and a repeatable group holds the ids of its rows, each row's field being
 * `group.rowId.field`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AttachmentId, StringId, TrimmedNonEmptyString } from "./primitives.ts";

const isFieldPathSegment = Schema.isPattern(/^[A-Za-z0-9_-]+$/);

/** A field or row ID; dots separate these IDs in field paths. */
export const FieldPathSegment = StringId.check(isFieldPathSegment);

export const hasDistinctIds = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length;

const FieldBase = {
  id: FieldPathSegment.annotate({
    description: "Identifier unique among sibling fields; used in dotted field paths.",
  }),
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "Guidance shown below the field label." }),
  ),
};

const DefaultValue = Schema.optionalKey(
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({
    description: "The value the field starts with; it must fit the field. File fields have none.",
  }),
);

const ValueField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literals(["text", "url", "number", "boolean", "date", "file"]),
  defaultValue: DefaultValue,
});

/** A URL field holds one web address; its field label supplies the visible link text. */
export const isUrlFieldValue = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\/\S+$/iu.test(value) && URL.canParse(value);

const SelectField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("select"),
  defaultValue: DefaultValue,
  options: Schema.Array(TrimmedNonEmptyString)
    .annotate({ description: "Allowed choices, shown as written." })
    .check(Schema.isMinLength(1)),
});

class GroupField extends Schema.Class<GroupField>("GroupField")({
  ...FieldBase,
  type: Schema.Literal("group"),
  repeatable: Schema.Boolean.annotate({ description: "Whether the group allows multiple rows." }),
  fields: Schema.Array(Schema.suspend((): Schema.Codec<Field> => Field)),
}) {}

export const Field = Schema.Union([ValueField, SelectField, GroupField]);

export type Field = typeof ValueField.Type | typeof SelectField.Type | GroupField;

const fieldIdsAreDistinct = (fields: ReadonlyArray<Field>): boolean =>
  hasDistinctIds(fields.map((field) => field.id)) &&
  fields.every((field) => field.type !== "group" || fieldIdsAreDistinct(field.fields));

const defaultsFit = (fields: ReadonlyArray<Field>): boolean =>
  fields.every((field) =>
    field.type === "group"
      ? defaultsFit(field.fields)
      : field.defaultValue === undefined ||
        (field.type !== "file" && fieldValueProblem(field, field.id, field.defaultValue) === null),
  );

/** A form's fields: distinct ids among siblings, and defaults that fit their fields. */
export const Fields = Schema.Array(Field).check(
  Schema.makeFilter(fieldIdsAreDistinct, { expected: "distinct field ids among siblings" }),
  Schema.makeFilter(defaultsFit, { expected: "default values that fit their fields" }),
);

/** Values by dotted key. */
export const FieldValues = Schema.Record(Schema.String, Schema.Json).check(
  Schema.isPropertyNames(Schema.toType(TrimmedNonEmptyString)),
);
export type FieldValues = typeof FieldValues.Type;

/**
 * The values these fields start with, by key: each default, in a group's fields too. A repeatable
 * group has no rows yet; `prefix` is the key of the row they start in.
 */
export const defaultValues = (
  fields: ReadonlyArray<Field>,
  prefix = "",
): Record<string, Schema.Json> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const key = prefix ? `${prefix}.${field.id}` : field.id;
      if (field.type !== "group")
        return field.defaultValue === undefined ? [] : [[key, field.defaultValue]];
      return field.repeatable ? [] : Object.entries(defaultValues(field.fields, key));
    }),
  );

export const holdsData = (value: Schema.Json | undefined): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim() !== "") &&
  (!Array.isArray(value) || value.length > 0);

const isRowIds = Schema.is(Schema.UniqueArray(FieldPathSegment));
const isFiniteNumber = Schema.is(Schema.Finite);
const isAttachmentId = Schema.is(AttachmentId);

export const rowIds = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  isRowIds(value) ? value : [];

export const groupRows = (field: Field, value: Schema.Json | undefined) =>
  field.type === "group" && field.repeatable ? rowIds(value) : [null];

/** The field at a dotted path and the rows it sits in, or why the path names no field. */
export const resolveFieldPath = (
  fields: ReadonlyArray<Field>,
  path: string,
):
  | {
      readonly field: Field;
      readonly rows: ReadonlyArray<{ readonly groupPath: string; readonly rowId: string }>;
    }
  | string => {
  const segments = path.split(".");
  const rows: Array<{ groupPath: string; rowId: string }> = [];
  let list = fields;
  let prefix = "";
  for (let at = 0; at < segments.length;) {
    const field = list.find((candidate) => candidate.id === segments[at]);
    if (field === undefined)
      return `There is no field ${path}. The fields ${prefix ? `in ${prefix} ` : ""}are:\n${describeFields(list, prefix)}`;
    const parent = prefix;
    prefix = prefix ? `${prefix}.${field.id}` : field.id;
    at += 1;
    if (at === segments.length) return { field, rows };
    if (field.type !== "group") return `${prefix} is a ${field.type} field, with no fields inside.`;
    if (field.repeatable) {
      const rowId = segments[at];
      at += 1;
      if (rowId === undefined || at === segments.length)
        return `${prefix} is a repeatable group: set ${prefix} to its row ids, or a row's field as ${prefix}.<rowId>.<field>.\n${describeFields([field], parent)}`;
      rows.push({ groupPath: prefix, rowId });
      prefix = `${prefix}.${rowId}`;
    }
    list = field.fields;
  }
  return `There is no field ${path}.`;
};

/** The row of `rows` missing from its group's row ids in `values`, or null when all are there. */
export const missingRow = (
  rows: ReadonlyArray<{ readonly groupPath: string; readonly rowId: string }>,
  values: FieldValues,
) => rows.find((row) => !rowIds(values[row.groupPath]).includes(row.rowId)) ?? null;

const decodeDateFieldValue = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);
const isDay = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Option.isSome(decodeDateFieldValue(value));

/** What a field takes, said the way someone filling it reads it. */
const expectation = (field: Field) => {
  switch (field.type) {
    case "text":
      return "text";
    case "url":
      return "an http:// or https:// URL as a string";
    case "number":
      return "a number, like 0.5";
    case "boolean":
      return "true or false";
    case "date":
      return "a date as YYYY-MM-DD";
    case "select":
      return `one of ${field.options.map((option) => JSON.stringify(option)).join(", ")}`;
    case "file":
      return "a file attached with this field's key";
    case "group":
      return field.repeatable
        ? `the list of its row ids, like ["r1", "r2"] (letters, digits, _ and -, each once)`
        : "values in its fields";
  }
};

const describeValue = (value: Schema.Json) => {
  if (typeof value === "string")
    return `the text ${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)}`;
  if (Array.isArray(value)) return "a list";
  if (value === null) return "nothing";
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
};

/** Each settable key of these fields and what it takes, one per line. */
const describeFields = (fields: ReadonlyArray<Field>, prefix = ""): string =>
  fields
    .map((field) => {
      const key = prefix ? `${prefix}.${field.id}` : field.id;
      if (field.type !== "group") return `${key}: ${expectation(field)}`;
      if (!field.repeatable) return describeFields(field.fields, key);
      return [
        `${key}: ${expectation(field)}; each row's fields are:`,
        describeFields(field.fields, `${key}.<rowId>`),
      ].join("\n");
    })
    .join("\n");

/**
 * Why a value doesn't fit the field at `key`, or null when it does. Checked before attachment
 * access checks or writes.
 */
export const fieldValueProblem = (field: Field, key: string, value: Schema.Json) => {
  const fits =
    field.type === "select"
      ? typeof value === "string" && field.options.includes(value)
      : field.type === "group"
        ? field.repeatable && isRowIds(value)
        : field.type === "text"
          ? typeof value === "string"
          : field.type === "url"
            ? isUrlFieldValue(value)
            : field.type === "number"
              ? isFiniteNumber(value)
              : field.type === "boolean"
                ? typeof value === "boolean"
                : field.type === "date"
                  ? isDay(value)
                  : isAttachmentId(value);
  if (fits) return null;
  if (field.type === "group" && !field.repeatable)
    return `${key} is a group: set its fields instead.\n${describeFields(field.fields, key)}`;
  if (field.type === "file")
    return `${key} takes the id of a file you uploaded; got ${describeValue(value)}.`;
  return `${key} takes ${expectation(field)}; got ${describeValue(value)}.`;
};

/**
 * Why a whole set of values doesn't fit the fields, or null when it does: every key names a field
 * in a row its group lists, and every value fits its field. Fields left out have no value.
 */
export const valuesProblem = (fields: ReadonlyArray<Field>, values: FieldValues) => {
  for (const [key, value] of Object.entries(values)) {
    const resolved = resolveFieldPath(fields, key);
    if (typeof resolved === "string") return resolved;
    const missing = missingRow(resolved.rows, values);
    if (missing !== null)
      return `${missing.groupPath} has no row ${missing.rowId}: list it in ${missing.groupPath}'s row ids.`;
    const problem = fieldValueProblem(resolved.field, key, value);
    if (problem !== null) return problem;
  }
  return null;
};

/** The keys of `values` that hold files, by the fields they fill. */
export const fileKeys = (fields: ReadonlyArray<Field>, values: FieldValues) =>
  Object.keys(values).filter((key) => {
    const resolved = resolveFieldPath(fields, key);
    return typeof resolved !== "string" && resolved.field.type === "file";
  });

/**
 * The values with the field at `key` set to `value`, or cleared by null. Setting a repeatable
 * group's row ids drops the values of the rows it no longer lists and starts new rows with their
 * defaults.
 */
export const withFieldValue = (
  fields: ReadonlyArray<Field>,
  values: FieldValues,
  key: string,
  value: Schema.Json,
): FieldValues => {
  const resolved = resolveFieldPath(fields, key);
  const field = typeof resolved === "string" ? null : resolved.field;
  let next = Object.fromEntries(Object.entries(values).filter(([other]) => other !== key));
  if (field?.type === "group" && field.repeatable) {
    const before = rowIds(values[key]);
    const after = rowIds(value);
    next = {
      ...Object.fromEntries(
        Object.entries(next).filter(
          ([other]) =>
            !other.startsWith(`${key}.`) ||
            after.includes(other.slice(key.length + 1).split(".")[0] ?? ""),
        ),
      ),
      ...Object.fromEntries(
        after
          .filter((rowId) => !before.includes(rowId))
          .flatMap((rowId) => Object.entries(defaultValues(field.fields, `${key}.${rowId}`))),
      ),
    };
  }
  return holdsData(value) ? { ...next, [key]: value } : next;
};
