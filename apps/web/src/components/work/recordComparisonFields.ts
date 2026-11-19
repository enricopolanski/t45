import type { Collection } from "@t45/contracts/models/Collection";
import {
  comparisonGroupReference,
  type ComparisonFields,
  type Field,
} from "@t45/contracts/models/Field";

type RecordFields = Pick<Collection, "fields" | "primaryKeyFieldId">;

export const resolveComparisonFields = (layout: ComparisonFields | undefined) => {
  const automatic = layout !== undefined && "hidden" in layout ? layout : undefined;
  const shown =
    layout === undefined || "hidden" in layout
      ? undefined
      : "shown" in layout
        ? layout.shown
        : layout;
  return {
    shown,
    hidden: automatic?.hidden ?? [],
    order: automatic?.order,
    derived: layout !== undefined && "derived" in layout ? (layout.derived ?? []) : [],
  };
};

export const canUseInComparisonTemplate = (field: Field) =>
  field.type !== "group" && field.type !== "file" && field.type !== "records";

/** Resolve a template's operand against the fields of a record. */
export const resolveComparisonReference = (
  fields: ReadonlyArray<Field>,
  reference: string,
  isNumber: boolean,
) => {
  const matches = (field: Field, id: string) =>
    field.id === id && (isNumber ? field.type === "number" : canUseInComparisonTemplate(field));
  const [, groupId, sortBy, fieldId] = comparisonGroupReference.exec(reference) ?? [];
  if (groupId === undefined || sortBy === undefined || fieldId === undefined) {
    const field = fields.find((candidate) => matches(candidate, reference));
    return field === undefined ? undefined : { field, group: undefined };
  }
  for (const group of fields) {
    if (
      group.id !== groupId ||
      group.type !== "group" ||
      !group.repeatable ||
      !group.fields.some((candidate) => candidate.id === sortBy && candidate.type === "number")
    )
      continue;
    const field = group.fields.find((candidate) => matches(candidate, fieldId));
    if (field !== undefined) return { field, group: { id: groupId, sortBy } };
  }
  return undefined;
};

/** Put named fields in the preferred order, then keep unlisted fields in their original order. */
export const orderComparisonFields = <A>(
  fields: ReadonlyArray<A>,
  keyOf: (field: A) => string,
  order: ReadonlyArray<string> | undefined,
) => {
  if (order === undefined) return fields;
  const positions = new Map(order.map((key, index) => [key, index]));
  const position = (field: A) => positions.get(keyOf(field)) ?? order.length;
  return fields.toSorted((left, right) => position(left) - position(right));
};

/** The top-level properties of both records, aligned by field ID in source-first order. */
export const listComparisonFields = (proposed: RecordFields, source?: RecordFields) =>
  [
    ...new Map(
      [...(source?.fields ?? []), ...proposed.fields].map((field) => [field.id, field]),
    ).values(),
  ].filter(
    (field) =>
      field.id !== proposed.primaryKeyFieldId &&
      field.id !== source?.primaryKeyFieldId &&
      field.type !== "group" &&
      field.type !== "file",
  );
