import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { AttachmentId } from "./Attachment.ts";
import { CalculationEdits, CalculationPreview, CalculationReview } from "./CalculationReview.ts";
import {
  type Field,
  FieldPathSegment,
  type FieldValues,
  hasDistinctIds,
  StepFieldReference,
  valuesProblem,
} from "./Field.ts";
import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "./primitives.ts";
import { StepPreviewColumns } from "./StepPreview.ts";
import {
  StepResultSnapshot,
  type StepResultGroup,
  type StepResultValue,
} from "./StepResultHistory.ts";

export const CalculatorInput = Schema.Struct({
  ...StepFieldReference.fields,
  records: Schema.optionalKey(
    Schema.Struct({
      fields: Schema.UniqueArray(FieldPathSegment),
      includeProposals: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

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
  review: Schema.optionalKey(Schema.Literal(true)),
  sourceStepId: StringId,
  inputs: Schema.Record(TrimmedNonEmptyString, CalculatorInput),
  outputs: Schema.Record(TrimmedNonEmptyString, FieldPathSegment),
  labels: Schema.optionalKey(CalculatorLabels),
  previewColumns: Schema.optionalKey(StepPreviewColumns),
  exportTemplateId: Schema.optionalKey(AttachmentId),
  exportAutomationId: Schema.optionalKey(StringId),
});
export type StepCalculator = typeof StepCalculator.Type;

const ScriptExport = Schema.Struct({
  entrypoint: TrimmedNonEmptyString,
  filename: TrimmedNonEmptyString.check(Schema.isMaxLength(200), Schema.isPattern(/^[^/\\]+$/u)),
  mimeType: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[\w.+-]+\/[\w.+-]+$/u),
  ),
  label: Schema.optionalKey(TrimmedNonEmptyString),
  capabilities: Schema.optionalKey(Schema.UniqueArray(StringId)),
});

const ScriptCalculator = Schema.Struct({
  entrypoint: TrimmedNonEmptyString,
  inputs: Schema.UniqueArray(TrimmedNonEmptyString),
  outputs: Schema.UniqueArray(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  review: Schema.optionalKey(Schema.Literal(true)),
  export: Schema.optionalKey(ScriptExport),
});

const decodeScriptCalculator = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptCalculator));

export const readScriptCalculator = (files: Readonly<Record<string, string>>) => {
  const calculator = Option.getOrNull(decodeScriptCalculator(files["calculation.json"]));
  return calculator !== null &&
    Object.hasOwn(files, calculator.entrypoint) &&
    (calculator.export === undefined || Object.hasOwn(files, calculator.export.entrypoint))
    ? calculator
    : null;
};

const decodeScriptExport = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptExport));

export const readScriptExport = (files: Readonly<Record<string, string>>) => {
  if (!Object.hasOwn(files, "export.json")) return readScriptCalculator(files)?.export ?? null;
  const config = Option.getOrNull(decodeScriptExport(files["export.json"]));
  return config !== null && Object.hasOwn(files, config.entrypoint) ? config : null;
};

export const isScriptOutputField = <F extends typeof Field.Encoded>(
  field: F,
): field is Extract<F, { type: "number" | "text" | "select" | "group" }> =>
  (!field.isReviewed &&
    (field.type === "number" || field.type === "text" || field.type === "select")) ||
  (field.type === "group" &&
    field.repeatable &&
    field.recordReview === undefined &&
    field.fields.length > 0 &&
    field.fields.every(
      ({ type, isReviewed }) =>
        !isReviewed && (type === "text" || type === "number" || type === "select"),
    ));

export const getScriptOutputFields = <F extends { readonly id: string }>(
  calculator: StepCalculator,
  fields: ReadonlyArray<F>,
) => {
  const ids = new Set(Object.values(calculator.outputs));
  return fields.filter(({ id }) => ids.has(id));
};

const ScriptRows = Schema.Array(
  Schema.Struct({
    id: FieldPathSegment,
    values: Schema.Record(FieldPathSegment, Schema.Union([Schema.String, Schema.Finite])),
  }),
).check(
  Schema.makeFilter((rows) => hasDistinctIds(rows.map(({ id }) => id)), {
    expected: "distinct row ids",
  }),
);
const decodeScriptRows = Schema.decodeUnknownOption(ScriptRows);

/** Interpret the script's named outputs using the workflow's field definitions. */
export const buildScriptResult = (
  calculator: StepCalculator,
  fields: ReadonlyArray<Field>,
  outputs: Readonly<Record<string, Schema.Json>>,
): Pick<StepResultSnapshot, "results" | "groups"> | string => {
  const mappings = Object.entries(calculator.outputs);
  if (
    Object.keys(outputs).length !== mappings.length ||
    !mappings.every(([name]) => Object.hasOwn(outputs, name))
  )
    return "The calculation must return every configured output.";

  const results: Array<StepResultValue> = [];
  const groups: Array<StepResultGroup> = [];
  for (const [name, id] of mappings) {
    const field = fields.find((field) => field.id === id);
    if (field === undefined || !isScriptOutputField(field))
      return `The calculation output ${name} has no compatible field.`;
    const output = outputs[name];
    if (field.type !== "group") {
      if (
        (typeof output !== "number" && typeof output !== "string") ||
        valuesProblem([field], { [id]: output }) !== null
      )
        return `The calculation output ${name} does not fit its field.`;
      results.push(
        typeof output === "number"
          ? { id, type: "number", value: output }
          : { id, type: "text", value: output },
      );
    } else {
      const decoded = decodeScriptRows(output);
      if (Option.isNone(decoded))
        return `The calculation output ${name} must be an array of rows with distinct ids and values.`;
      const rows: Array<StepResultGroup["rows"][number]> = [];
      for (const row of decoded.value) {
        const problem = valuesProblem(field.fields, row.values);
        if (problem !== null) return `${name}.${row.id}: ${problem}`;
        rows.push({
          id: row.id,
          values: field.fields.flatMap<StepResultValue>(({ id }) => {
            const value = Object.hasOwn(row.values, id) ? row.values[id] : undefined;
            return typeof value === "number"
              ? [{ id, type: "number" as const, value }]
              : typeof value === "string"
                ? [{ id, type: "text" as const, value }]
                : [];
          }),
        });
      }
      groups.push({ id, rows });
    }
  }
  return groups.length === 0 ? { results } : { results, groups };
};

export const readScriptResultValues = ({ results, groups = [] }: StepResultSnapshot): FieldValues =>
  Object.fromEntries([
    ...results.map(({ id, value }) => [id, value] as const),
    ...groups.flatMap(({ id, rows }) => [
      [id, rows.map((row) => row.id)] as const,
      ...rows.flatMap((row) =>
        row.values.map((value) => [`${id}.${row.id}.${value.id}`, value.value] as const),
      ),
    ]),
  ]);

/** A calculation replaces entire output groups, including rows and cells it stopped producing. */
export const applyScriptResultValues = (
  current: FieldValues,
  outputs: FieldValues,
): FieldValues => ({
  ...Object.fromEntries(
    Object.entries(current).filter(([key]) => !Object.hasOwn(outputs, key.split(".")[0]!)),
  ),
  ...outputs,
});

export const StepCalculation = Schema.Struct({
  rows: Schema.Record(FieldPathSegment, CalculationEdits),
  approvedRevision: Schema.optionalKey(TrimmedNonEmptyString),
});

export const CalculationResult = Schema.Struct({
  ...StepResultSnapshot.fields,
  review: Schema.optionalKey(CalculationReview),
  preview: Schema.optionalKey(CalculationPreview),
  data: Schema.optionalKey(Schema.Json),
});
export type CalculationResult = typeof CalculationResult.Type;

const ScriptedReview = Schema.Struct({
  outputs: Schema.Record(TrimmedNonEmptyString, Schema.Json),
  review: Schema.optionalKey(CalculationReview),
  preview: Schema.optionalKey(CalculationPreview),
  data: Schema.optionalKey(Schema.Json),
});
const decodeScriptedReview = Schema.decodeUnknownOption(ScriptedReview);

export const readScriptedReview = (output: unknown) =>
  Option.getOrNull(decodeScriptedReview(output));

export type StepCalculation = typeof StepCalculation.Type;
