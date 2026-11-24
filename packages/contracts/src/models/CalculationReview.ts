import * as Schema from "effect/Schema";

import { FieldDecimals, FieldPathSegment } from "./Field.ts";
import { StepPreviewColumns } from "./StepPreview.ts";
import { StepResultSnapshot, StepResultValue } from "./StepResultHistory.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./primitives.ts";

const EditValue = Schema.Union([Schema.Finite, Schema.String, Schema.Null]);
export const CalculationEdits = Schema.Record(TrimmedNonEmptyString, EditValue);
export type CalculationEdits = typeof CalculationEdits.Type;

const Editor = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  value: EditValue,
  sourceValue: EditValue,
});
const TextEditor = Schema.Struct({ ...Editor.fields, type: Schema.Literal("text") });
const NumberEditor = Schema.Struct({
  ...Editor.fields,
  type: Schema.Literal("number"),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  decimals: Schema.optionalKey(FieldDecimals),
  isMinExclusive: Schema.optionalKey(Schema.Boolean),
});
export const CalculationForm = Schema.Struct({
  rowId: FieldPathSegment,
  label: Schema.optionalKey(Schema.String),
  actionLabel: Schema.optionalKey(Schema.String),
  editors: Schema.Array(Schema.Union([TextEditor, NumberEditor])),
});
export type CalculationForm = typeof CalculationForm.Type;

const Metric = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  value: Schema.NullOr(Schema.Finite),
  decimals: FieldDecimals,
  unit: Schema.String,
});
const Line = Schema.Struct({
  text: Schema.String,
  link: Schema.optionalKey(Schema.String),
});
const Card = Schema.Struct({
  label: Schema.String,
  value: Schema.optionalKey(StepResultValue),
  lines: Schema.Array(Line),
  details: Schema.optionalKey(Schema.Struct({ label: Schema.String, lines: Schema.Array(Line) })),
});
export type CalculationCard = typeof Card.Type;

const Section = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: Schema.String,
  forms: Schema.Array(CalculationForm),
  cards: Schema.Array(Card),
  rows: Schema.Array(
    Schema.Struct({
      id: FieldPathSegment,
      label: Schema.String,
      note: Schema.String,
      metrics: Schema.Array(Metric),
      form: CalculationForm,
      isVisible: Schema.Boolean,
    }),
  ),
  additionalRowsLabel: Schema.optionalKey(Schema.String),
  emptyRowsLabel: Schema.optionalKey(Schema.String),
});
export type CalculationSection = typeof Section.Type;

export const CalculationReview = Schema.Struct({
  sections: Schema.Array(Section),
  canApprove: Schema.Boolean,
  approvalLabel: Schema.optionalKey(Schema.String),
  blockingReason: Schema.optionalKey(Schema.String),
});
export type CalculationReview = typeof CalculationReview.Type;

export const CalculationPreviewChanges = Schema.Struct({
  count: NonNegativeInt,
  title: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  sections: Schema.Array(
    Schema.Struct({
      key: TrimmedNonEmptyString,
      label: Schema.String,
      cards: Schema.Array(Card),
    }),
  ),
});

export const CalculationPreview = Schema.Struct({
  columns: StepPreviewColumns,
  rows: Schema.Array(
    Schema.Struct({
      key: TrimmedNonEmptyString,
      label: Schema.String,
      thumbnailInput: Schema.optionalKey(TrimmedNonEmptyString),
      cells: Schema.Record(
        TrimmedNonEmptyString,
        Schema.Struct({
          values: Schema.Array(StepResultValue),
          note: Schema.optionalKey(Schema.String),
        }),
      ),
      history: StepResultSnapshot,
    }),
  ),
  changes: Schema.optionalKey(CalculationPreviewChanges),
});

/** The script describes what can be edited, while the workflow owns the write and approval. */
export const acceptsCalculationEdits = (
  sections: CalculationReview["sections"],
  rowId: string,
  values: CalculationEdits,
) => {
  const editors = sections.flatMap(({ forms, rows }) =>
    [...forms, ...rows.map(({ form }) => form)]
      .filter((form) => form.rowId === rowId)
      .flatMap(({ editors }) => editors),
  );
  return (
    editors.length > 0 &&
    Object.entries(values).every(([id, value]) => {
      const editor = editors.find((field) => field.id === id);
      if (editor === undefined) return false;
      if (value === null) return true;
      if (editor.type === "text") return typeof value === "string" && value.trim() !== "";
      if (typeof value !== "number") return false;
      if (
        editor.min !== undefined &&
        (value < editor.min || (editor.isMinExclusive && value === editor.min))
      )
        return false;
      if (editor.max !== undefined && value > editor.max) return false;
      return editor.decimals === undefined || Number(value.toFixed(editor.decimals)) === value;
    })
  );
};
