import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { FieldPathSegment, StepFieldReference } from "./Field.ts";
import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "./primitives.ts";
import { StepPreviewColumns } from "./StepPreview.ts";

export const CalculatorInput = StepFieldReference;

export const CalculatorLabels = Schema.Record(TrimmedNonEmptyString, Schema.String);
export type CalculatorLabels = typeof CalculatorLabels.Type;

export const formatCalculatorLabel = (
  labels: CalculatorLabels,
  key: string,
  ...values: ReadonlyArray<string | number>
) => {
  const label = Object.hasOwn(labels, key) ? labels[key] : undefined;
  return label?.replace(/\{(\d+)\}/gu, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder,
  );
};

export const StepCalculator = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: NonNegativeInt,
  kind: Schema.optionalKey(Schema.Literal("script")),
  sourceStepId: StringId,
  inputs: Schema.Record(TrimmedNonEmptyString, CalculatorInput),
  outputs: Schema.Record(TrimmedNonEmptyString, FieldPathSegment),
  labels: Schema.optionalKey(CalculatorLabels),
  previewColumns: Schema.optionalKey(StepPreviewColumns),
});
export type StepCalculator = typeof StepCalculator.Type;

const ScriptCalculator = Schema.Struct({
  entrypoint: TrimmedNonEmptyString,
  inputs: Schema.UniqueArray(TrimmedNonEmptyString),
  outputs: Schema.UniqueArray(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});

const decodeScriptCalculator = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptCalculator));

export const readScriptCalculator = (files: Readonly<Record<string, string>>) => {
  const calculator = Option.getOrNull(decodeScriptCalculator(files["calculation.json"]));
  return calculator !== null && Object.hasOwn(files, calculator.entrypoint) ? calculator : null;
};
