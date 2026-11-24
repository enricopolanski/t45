import type { StepCalculator } from "@t45/contracts/models/StepCalculator";
import { isSameInput, type StepInput } from "@t45/contracts/models/Workflow";
import type { CalculatorOption } from "@t45/contracts/resources/Workflows";
import { useTranslation } from "~/i18n/locale";

import { Field } from "../ui/field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { DraftStep, inputSourcesFor } from "./workflowLogic";

const inputKey = ({ stepId, fieldId }: StepInput) => `${stepId}.${fieldId}`;

export function CalculatorEditor({
  step,
  sourceStepId,
  sources,
  calculators,
  onChange,
  disabled,
}: {
  readonly step: DraftStep;
  readonly sourceStepId: string;
  readonly sources: ReturnType<typeof inputSourcesFor>;
  readonly calculators: ReadonlyArray<CalculatorOption>;
  readonly onChange: (step: DraftStep) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const binding = step.calculator;
  const selected =
    binding?.kind === "script" ? calculators.find(({ id }) => id === binding.id) : undefined;
  const fields = step.fields.filter((field) => field.type === "number");

  const changeBinding = (next: StepCalculator | undefined, input?: StepInput) => {
    const { calculator: _, previewFields, ...rest } = step;
    const outputs = Object.values(next?.outputs ?? {});
    let calculator = next;
    if (next?.previewColumns !== undefined) {
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
            const sourceLabel =
              input && sources.find((source) => isSameInput(input)(source.input))?.label;
            return (
              <Field key={`input-${name}`} size="xs" label={t("Calculation input {0}", name)}>
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
                    <SelectValue placeholder={t("Choose a field")}>{sourceLabel}</SelectValue>
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
    </div>
  );
}
