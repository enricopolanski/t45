import type { Field } from "@t45/contracts/models/Field";

/** A URL displayed on another field stays editable in details, without its own table column. */
export const isTableColumn = (field: Field) =>
  field.isDetailOnly !== true && (field.type !== "url" || field.displayLinkOn === undefined);
