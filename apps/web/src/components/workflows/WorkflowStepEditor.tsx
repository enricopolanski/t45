import { type Translate, useTranslation } from "~/i18n/locale";
import { isSameInput } from "@t45/contracts/models/Workflow";
import type { DraftField, DraftStep, inputSourcesFor } from "./workflowLogic";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useApiQuery } from "../../state/rpc";
import { collectionListQuery } from "../collections/collectionQueries";
import {
  AddButton,
  FieldsEditor,
  MoveRemove,
  type Placed,
  type Placement,
} from "../fields/FieldsEditor";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { FoldChevron } from "../work/CardFold";
import { StepAutomationsEditor } from "../work/StepAutomationsEditor";
import { ComparisonCriteriaEditor } from "./ComparisonCriteriaEditor";
import { ComparisonFieldsEditor } from "./ComparisonFieldsEditor";
import { GroupLayoutButton } from "./GroupLayout";
import { RecordReviewSettings } from "./RecordReviewSettings";
import { blankStep, listEntries } from "./workflowLogic";

/** What a step holds, shown beside its title, e.g. "5 fields · 1 sub-step". */
function stepSummary(step: DraftStep, t: Translate) {
  const fields = t(step.fields.length === 1 ? "{0} field" : "{0} fields", step.fields.length);
  return step.subSteps.length > 0
    ? `${fields} · ${t(step.subSteps.length === 1 ? "{0} sub-step" : "{0} sub-steps", step.subSteps.length)}`
    : fields;
}

/** A sub-step in its parent: its title, a way to open its own editor, to move it, and to remove it. */
function SubStepRow({
  place,
  onOpen,
  disabled,
}: {
  readonly place: Placed<DraftStep>;
  readonly onOpen: () => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const name = place.entry.name.trim();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
      <span
        className={
          name
            ? "min-w-0 flex-1 truncate text-sm font-medium"
            : "min-w-0 flex-1 truncate text-sm text-muted-foreground"
        }
      >
        {name || t("Untitled sub-step")}
      </span>
      <Button type="button" size="xs" variant="outline" onClick={onOpen} disabled={disabled}>
        {t("Edit")}
      </Button>
      <MoveRemove what={t("sub-step {0}", name)} place={place} disabled={disabled} />
    </div>
  );
}

/** Collection IDs linked by an input field, including inside a group. */
function listInputCollectionIds(field: DraftField): ReadonlyArray<string> {
  if (field.type === "records") return [field.collectionId];
  return field.type === "group" ? field.fields.flatMap(listInputCollectionIds) : [];
}

/**
 * One step or sub-step: its name, instructions, fields, and sub-steps.
 * Sub-steps show as their titles and open in an editor of their own. A step in the list
 * of the workflow's steps moves and is removed here; a sub-step, from its parent.
 */
export function WorkflowStepEditor({
  workflow,
  step,
  inputSources,
  position,
  onChange,
  onOpenSubStep,
  disabled,
}: {
  /** The workflow the step is of, whose tickets preview a group's layout. */
  readonly workflow: { readonly id: string; readonly name: string };
  readonly step: DraftStep;
  /** The fields of earlier steps it may read. */
  readonly inputSources: ReturnType<typeof inputSourcesFor>;
  /** Its place among the workflow's steps, with moving and removing it; null for a sub-step. */
  readonly position: Placement | null;
  readonly onChange: (step: DraftStep) => void;
  readonly onOpenSubStep: (key: string) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  // A sub-step's own editor is always open; a step in the list starts open only when new.
  const [startsOpen] = useState(position === null || step.name === "");
  const collections = useApiQuery(collectionListQuery).data ?? [];
  const inputs = step.inputs ?? [];
  const inputKey = (input: (typeof inputs)[number]) => `${input.stepId}.${input.fieldId}`;
  const unboundSources = inputSources.filter(({ input }) => !inputs.some(isSameInput(input)));
  const inputCollectionIds = new Set(
    inputs.flatMap((input) => {
      const source = inputSources.find((candidate) => isSameInput(input)(candidate.input));
      return source === undefined ? [] : listInputCollectionIds(source.field);
    }),
  );
  const inputCollections = [...inputCollectionIds].flatMap((id) =>
    collections.filter((collection) => collection.id === id),
  );
  const title = (
    <Field label={position === null ? t("Sub-step title") : t("Step title")} size="xs">
      <Input
        placeholder={t("Collect documents, gather requirements, analyze request…")}
        value={step.name}
        onChange={(event) => onChange({ ...step, name: event.target.value })}
        autoFocus={step.name === ""}
        disabled={disabled}
      />
    </Field>
  );
  return (
    <Collapsible className="flex flex-col" defaultOpen={startsOpen}>
      {position === null ? (
        <div className="bg-muted/40 px-4 py-2.5">{title}</div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2.5">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left">
            <FoldChevron />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {position.index + 1}
            </span>
            <span
              className={
                step.name
                  ? "truncate text-sm font-medium"
                  : "truncate text-sm text-muted-foreground"
              }
            >
              {step.name || t("New step")}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{stepSummary(step, t)}</span>
          </CollapsibleTrigger>
          <MoveRemove what={t("step {0}", step.name)} place={position} disabled={disabled} />
        </div>
      )}
      <CollapsiblePanel>
        <div className="flex flex-col gap-4 border-t border-border px-4 py-3.5">
          {position !== null ? title : null}
          <Field label={t("Instructions")} size="xs">
            <Textarea
              placeholder={t("Guidance for a person, or the brief for an agent")}
              value={step.instructions}
              onChange={(event) => onChange({ ...step, instructions: event.target.value })}
              disabled={disabled}
            />
          </Field>
          <hr />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{t("Fields")}</span>
              <p className="text-xs text-muted-foreground">
                {t("Data required to produce in this step.")}
              </p>
            </div>
            <FieldsEditor
              fields={step.fields}
              depth={0}
              areColumns={false}
              collections={collections}
              areReviewable
              comparisonFieldsEditor={(field, setField) => {
                const collection = collections.find(({ id }) => id === field.collectionId);
                if (collection === undefined) return null;
                return (
                  <div className="flex flex-wrap gap-2">
                    <ComparisonFieldsEditor
                      collection={collection}
                      inputCollections={inputCollections}
                      fields={field.comparisonFields}
                      onChange={(comparisonFields) => {
                        const { comparisonFields: _, ...rest } = field;
                        setField(
                          comparisonFields === undefined ? rest : { ...rest, comparisonFields },
                        );
                      }}
                      disabled={disabled}
                    />
                    {step.fields.some((f) => f.id === field.id) && field.isReviewed && (
                      <ComparisonCriteriaEditor
                        sources={inputSources.filter((source) =>
                          inputs.some(isSameInput(source.input)),
                        )}
                        mapping={field.comparisonCriteria}
                        disabled={disabled}
                        onChange={(mapping) => {
                          const { comparisonCriteria: _, ...rest } = field;
                          setField(mapping ? { ...rest, comparisonCriteria: mapping } : rest);
                        }}
                      />
                    )}
                  </div>
                );
              }}
              groupLayout={(group, setGroup) => (
                <div className="flex flex-wrap gap-2">
                  {step.fields.some((field) => field.id === group.id) ? (
                    <RecordReviewSettings
                      group={group}
                      fields={step.fields}
                      onChange={setGroup}
                      disabled={disabled}
                    />
                  ) : null}
                  <GroupLayoutButton
                    workflowId={workflow.id}
                    stepId={step.id}
                    trail={`${workflow.name} · ${step.name}`}
                    group={group}
                    onChange={setGroup}
                    disabled={disabled}
                  />
                </div>
              )}
              onChange={(fields) => onChange({ ...step, fields })}
              disabled={disabled}
            />
          </div>
          <hr />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{t("Inputs")}</span>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Fields of earlier steps this step reads. Whoever works on it sees nothing else of them.",
                )}
              </p>
            </div>
            {inputs.map((input) => {
              const label =
                inputSources.find((source) => isSameInput(input)(source.input))?.label ??
                t("A field that no earlier step has");
              return (
                <div
                  key={inputKey(input)}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("Remove input {0}", label)}
                    onClick={() =>
                      onChange({ ...step, inputs: inputs.filter((other) => other !== input) })
                    }
                    disabled={disabled}
                  >
                    <XIcon />
                  </Button>
                </div>
              );
            })}
            <Select
              value={null}
              disabled={disabled || unboundSources.length === 0}
              onValueChange={(key) => {
                const source = unboundSources.find(({ input }) => inputKey(input) === key);
                if (source) onChange({ ...step, inputs: [...inputs, source.input] });
              }}
            >
              <SelectTrigger aria-label={t("Add input")}>
                <SelectValue placeholder={t("Add input")} />
              </SelectTrigger>
              <SelectPopup>
                {unboundSources.map(({ input, label }) => (
                  <SelectItem key={inputKey(input)} value={inputKey(input)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <hr />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{t("Automations")}</span>
              <p className="text-xs text-muted-foreground">
                {t("What people can run on this step, in every project.")}
              </p>
            </div>
            <StepAutomationsEditor
              automationIds={step.automationIds ?? []}
              disabled={disabled}
              onChange={(automationIds) => onChange({ ...step, automationIds })}
            />
            <label className="mt-1 flex w-fit items-center gap-2 text-sm">
              <Switch
                size="sm"
                checked={step.isDoneWhenApproved ?? false}
                onCheckedChange={(isDoneWhenApproved) => onChange({ ...step, isDoneWhenApproved })}
                disabled={disabled}
              />
              {t("Done once every review is confirmed")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                "The step marks itself done and the ticket moves on as soon as its fields are complete and every record review is confirmed, by a person or an automation.",
              )}
            </p>
          </div>
          <hr />
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t("Sub-steps")}</span>
            {listEntries(step.subSteps, (subSteps) => onChange({ ...step, subSteps })).map(
              (place) => (
                <SubStepRow
                  key={place.entry.id}
                  place={place}
                  onOpen={() => onOpenSubStep(place.entry.id)}
                  disabled={disabled}
                />
              ),
            )}
            <AddButton
              label={t("Add sub-step")}
              onClick={() => {
                const added = blankStep();
                onChange({ ...step, subSteps: [...step.subSteps, added] });
                onOpenSubStep(added.id);
              }}
              disabled={disabled}
            />
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
