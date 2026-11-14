import { type Field, groupRows } from "@t45/contracts/models/Field";
import type { FieldView } from "@t45/contracts/resources/Workflows";
import type * as Schema from "effect/Schema";

/** A file a field holds, as a form shows it. */
type FieldFile = NonNullable<FieldView["file"]>;

/**
 * The fields as a form shows them, with their values by dotted key; `fileOf` names the file an
 * attachment id stands for, or null when there's none to show.
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
    return {
      file: field.type === "file" && typeof value === "string" ? fileOf(value) : null,
      key: path,
      label: field.label,
      description: field.description ?? "",
      type: field.type,
      options: field.type === "select" ? field.options : [],
      value: field.type === "group" ? null : (value ?? null),
      repeatable: field.type === "group" && field.repeatable,
      rowFields: field.type === "group" && field.repeatable ? field.fields : [],
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
