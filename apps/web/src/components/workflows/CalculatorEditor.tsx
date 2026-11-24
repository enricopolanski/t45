import { isScriptOutputField, type StepCalculator } from "@t45/contracts/models/StepCalculator";
import type { Collection } from "@t45/contracts/models/Collection";
import { isSameInput, type StepInput } from "@t45/contracts/models/Workflow";
import type { CalculatorOption } from "@t45/contracts/resources/Workflows";
import { useTranslation } from "~/i18n/locale";
import { useState } from "react";

import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ErrorText } from "../ui/error-text";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { uploadFile } from "../work/StepFields";
import type { DraftStep, inputSourcesFor } from "./workflowLogic";

const inputKey = ({ stepId, fieldId }: StepInput) => `${stepId}.${fieldId}`;

export function CalculatorEditor({
  step,
  sourceStepId,
  sources,
  collections,
  calculators,
  onChange,
  disabled,
}: {
  readonly step: DraftStep;
  readonly sourceStepId: string;
  readonly sources: ReturnType<typeof inputSourcesFor>;
  readonly collections: ReadonlyArray<Collection>;
  readonly calculators: ReadonlyArray<CalculatorOption>;
  readonly onChange: (step: DraftStep) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const binding = step.calculator;
  const selected =
    binding?.kind === "script" ? calculators.find(({ id }) => id === binding.id) : undefined;
  const fields = step.fields.filter(isScriptOutputField);

  const changeBinding = (next: StepCalculator | undefined, input?: StepInput) => {
    const { calculator: _, previewFields, ...rest } = step;
    const outputs = Object.values(next?.outputs ?? {});
    let calculator = next;
    if (next?.previewColumns !== undefined && !next.review) {
      const { previewColumns, ...mapping } = next;
      const columns = previewColumns.filter(({ id }) => outputs.includes(id));
      calculator = columns.length === 0 ? mapping : { ...mapping, previewColumns: columns };
    }
    onChange({
      ...rest,
      ...(input !== undefined && !(rest.inputs ?? []).some(isSameInput(input))
        ? { inputs: [...(rest.inputs ?? []), input] }
        : {}),
      ...(calculator === undefined ? {} : { calculator }),
      ...(previewFields === undefined
        ? {}
        : {
            previewFields: previewFields.filter(
              ({ stepId, fieldId }) => stepId !== step.id || outputs.includes(fieldId),
            ),
          }),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Field size="xs" label={t("Calculation automation")}>
        <Select
          value={binding?.id ?? ""}
          disabled={disabled}
          onValueChange={(id) => {
            if (id === "") changeBinding(undefined);
            else {
              const calculator = calculators.find((item) => item.id === id);
              if (calculator)
                changeBinding({
                  id: calculator.id,
                  kind: "script",
                  ...(calculator.review ? { review: true } : {}),
                  version: 1,
                  sourceStepId,
                  inputs: {},
                  outputs: {},
                });
            }
          }}
        >
          <SelectTrigger aria-label={t("Calculation automation")}>
            <SelectValue>{selected?.title ?? binding?.id ?? t("No calculation")}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("No calculation")}</SelectItem>
            {binding !== undefined && selected === undefined && (
              <SelectItem value={binding.id} disabled>
                {binding.id}
              </SelectItem>
            )}
            {calculators.map(({ id, title }) => (
              <SelectItem key={id} value={id}>
                {title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {selected !== undefined && binding !== undefined && (
        <div className="grid gap-2 sm:grid-cols-2">
          {selected.inputs.map((name) => {
            const input = Object.hasOwn(binding.inputs, name) ? binding.inputs[name] : undefined;
            const source = input && sources.find((source) => isSameInput(input)(source.input));
            const field = source?.field;
            const collection =
              field?.type === "records"
                ? collections.find(({ id }) => id === field.collectionId)
                : undefined;
            const records = input?.records;
            const setRecordInput = (records: NonNullable<typeof input>["records"]) => {
              if (source === undefined) return;
              changeBinding({
                ...binding,
                inputs: {
                  ...binding.inputs,
                  [name]: records === undefined ? source.input : { ...source.input, records },
                },
              });
            };
            return (
              <div key={`input-${name}`} className="flex min-w-0 flex-col gap-2">
                <Field size="xs" label={t("Calculation input {0}", name)}>
                  <Select
                    value={input === undefined ? null : inputKey(input)}
                    disabled={disabled}
                    onValueChange={(key) => {
                      const source = sources.find(({ input }) => inputKey(input) === key);
                      if (source)
                        changeBinding(
                          { ...binding, inputs: { ...binding.inputs, [name]: source.input } },
                          source.input,
                        );
                    }}
                  >
                    <SelectTrigger aria-label={t("Calculation input {0}", name)}>
                      <SelectValue placeholder={t("Choose a field")}>{source?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {sources.map(({ input, label }) => (
                        <SelectItem key={inputKey(input)} value={inputKey(input)}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                {collection !== undefined && (
                  <>
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={records !== undefined}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setRecordInput(checked ? { fields: [] } : undefined)
                        }
                      />
                      {t("Pass record fields")}
                    </label>
                    {records !== undefined && (
                      <>
                        <fieldset disabled={disabled} className="space-y-1">
                          <legend className="text-xs text-muted-foreground">
                            {t("Record fields")}
                          </legend>
                          <div className="max-h-48 overflow-y-auto rounded-md border p-2">
                            {collection.fields.map(({ id, label }) => (
                              <label key={id} className="flex min-h-7 items-center gap-2 text-xs">
                                <Checkbox
                                  checked={records.fields.includes(id)}
                                  disabled={disabled}
                                  onCheckedChange={(checked) =>
                                    setRecordInput({
                                      ...records,
                                      fields: checked
                                        ? [...records.fields, id]
                                        : records.fields.filter((selected) => selected !== id),
                                    })
                                  }
                                />
                                <span className="truncate">{label || id}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        {field?.isReviewed && (
                          <label className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={records.includeProposals ?? false}
                              disabled={disabled}
                              onCheckedChange={(includeProposals) =>
                                setRecordInput({ ...records, includeProposals })
                              }
                            />
                            {t("Include proposals awaiting review")}
                          </label>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {selected.outputs.map((name) => (
            <Field key={`output-${name}`} size="xs" label={t("Calculation output {0}", name)}>
              <Select
                value={Object.hasOwn(binding.outputs, name) ? binding.outputs[name] : null}
                disabled={disabled}
                onValueChange={(id) => {
                  if (typeof id === "string")
                    changeBinding({ ...binding, outputs: { ...binding.outputs, [name]: id } });
                }}
              >
                <SelectTrigger aria-label={t("Calculation output {0}", name)}>
                  <SelectValue placeholder={t("Choose a field")}>
                    {fields.find(({ id }) => id === binding.outputs[name])?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {fields
                    .filter(
                      ({ id }) =>
                        !Object.entries(binding.outputs).some(
                          ([output, field]) => output !== name && field === id,
                        ),
                    )
                    .map(({ id, label }) => (
                      <SelectItem key={id} value={id}>
                        {label || t("Untitled field")}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            </Field>
          ))}
        </div>
      )}
      {selected?.hasExport === true && binding !== undefined && (
        <div className="flex flex-col gap-2">
          <Field size="xs" label={t("Export template")}>
            <Input
              type="file"
              aria-label={t("Export template")}
              disabled={disabled || isUploading}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file === undefined) return;
                setIsUploading(true);
                setUploadError(null);
                void uploadFile(file)
                  .then((exportTemplateId) => changeBinding({ ...binding, exportTemplateId }))
                  .catch((error) => setUploadError(describeFailure(error)))
                  .finally(() => setIsUploading(false));
              }}
            />
          </Field>
          {binding.exportTemplateId !== undefined && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("Template attached")}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled || isUploading}
                onClick={() => {
                  const { exportTemplateId: _, ...rest } = binding;
                  changeBinding(rest);
                }}
              >
                {t("Remove")}
              </Button>
            </div>
          )}
          {uploadError && <ErrorText text={uploadError} />}
        </div>
      )}
    </div>
  );
}
