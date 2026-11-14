import { type Field, groupRows, isUrlFieldValue } from "@t45/contracts/models/Field";
import type { FieldView } from "@t45/contracts/resources/Workflows";
import type * as Schema from "effect/Schema";

/** A file a field holds, as a form shows it. */
type FieldFile = NonNullable<FieldView["file"]>;

/** The URL displayed on a sibling field, resolved within this record or group row. */
export const getFieldLink = (
  fieldId: string,
  fields: ReadonlyArray<Field>,
  values: Readonly<Record<string, Schema.Json>>,
  prefix = "",
) => {
  const source = fields.find((field) => field.type === "url" && field.displayLinkOn === fieldId);
  const value =
    source === undefined ? undefined : values[prefix ? `${prefix}.${source.id}` : source.id];
  return isUrlFieldValue(value) ? value : undefined;
};

/**
 * The fields as a form shows them, with their values by dotted key; `fileOf` names the file an
 * attachment id stands for, or null when there's none to show. A records field's collection and
 * records are left for whoever reads them to fill in.
 */
export const buildFieldViews = (
  fields: ReadonlyArray<Field>,
  values: Readonly<Record<string, Schema.Json>>,
  fileOf: (id: string) => FieldFile | null,
  prefix = "",
): Array<FieldView> =>
  fields.map((field) => {
    const path = prefix ? `${prefix}.${field.id}` : field.id;
    const value = values[path];
    const linkUrl = getFieldLink(field.id, fields, values, prefix);
    return {
      file: field.type === "file" && typeof value === "string" ? fileOf(value) : null,
      key: path,
      label: field.label,
      description: field.description ?? "",
      type: field.type,
      options: field.type === "select" ? field.options : [],
      value: field.type === "group" ? null : (value ?? null),
      ...(linkUrl === undefined ? {} : { linkUrl }),
      repeatable: field.type === "group" && field.repeatable,
      rowFields: field.type === "group" && field.repeatable ? field.fields : [],
      collection: null,
      records: [],
      rows:
        field.type === "group"
          ? groupRows(field, value).map((rowId) => ({
              id: rowId,
              fields: buildFieldViews(
                field.fields,
                values,
                fileOf,
                rowId === null ? path : `${path}.${rowId}`,
              ),
            }))
          : [],
    };
  });
