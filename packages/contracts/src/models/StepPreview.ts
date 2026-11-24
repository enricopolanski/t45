import * as Schema from "effect/Schema";

import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "./primitives.ts";

/** The column that names a result and can show its thumbnail. */
export const PREVIEW_ROW_LABEL = "$label";

export const StepPreviewColumn = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});
export type StepPreviewColumn = typeof StepPreviewColumn.Type;

export const StepPreviewColumns = Schema.Array(StepPreviewColumn).check(
  Schema.isMinLength(1),
  Schema.makeFilter((columns) => new Set(columns.map(({ id }) => id)).size === columns.length),
);
export type StepPreviewColumns = typeof StepPreviewColumns.Type;

export const StepPreviewLink = Schema.Struct({
  ticketId: StringId,
  ticketTitle: TrimmedNonEmptyString,
  stepDefinitionId: StringId,
  stepName: TrimmedNonEmptyString,
  stepNumber: NonNegativeInt,
});
