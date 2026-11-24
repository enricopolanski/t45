import * as Schema from "effect/Schema";

import { FieldDecimals, FieldPathSegment } from "./Field.ts";
import { TrimmedNonEmptyString } from "./primitives.ts";

export const StepResultValue = Schema.Union([
  Schema.Struct({
    id: TrimmedNonEmptyString,
    type: Schema.Literal("text"),
    value: Schema.String,
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString,
    type: Schema.Literal("number"),
    value: Schema.Finite,
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString,
    type: Schema.Literal("percentage"),
    value: Schema.Finite,
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString,
    type: Schema.Literal("currency"),
    value: Schema.Finite,
    currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
    maximumFractionDigits: Schema.optionalKey(FieldDecimals),
  }),
]);
export type StepResultValue = typeof StepResultValue.Type;

const StepResultGroup = Schema.Struct({
  id: FieldPathSegment,
  rows: Schema.Array(
    Schema.Struct({
      id: FieldPathSegment,
      values: Schema.Array(StepResultValue),
    }),
  ),
});
export type StepResultGroup = typeof StepResultGroup.Type;

export const StepResultSnapshot = Schema.Struct({
  inputRevision: Schema.optionalKey(TrimmedNonEmptyString),
  results: Schema.Array(StepResultValue),
  groups: Schema.optionalKey(Schema.Array(StepResultGroup)),
  sources: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      title: Schema.String,
      values: Schema.Array(StepResultValue),
    }),
  ),
});
export type StepResultSnapshot = typeof StepResultSnapshot.Type;

export const StepResultVersion = Schema.Struct({
  id: Schema.Int,
  recordedAt: Schema.DateTimeUtcFromString,
  snapshot: StepResultSnapshot,
});
