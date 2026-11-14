import { isSameInput } from "@t45/contracts/models/Workflow";
import type { DraftStep, inputSourcesFor } from "./workflowLogic";
import { XIcon } from "lucide-react";
import { useState } from "react";

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
import { Textarea } from "../ui/textarea";
import { FoldChevron } from "../work/CardFold";
import { StepAutomationsEditor } from "../work/StepAutomationsEditor";
import { plural } from "../work/workLogic";
import { blankStep, listEntries } from "./workflowLogic";

/** What a step holds, shown beside its title, e.g. "5 fields · 1 sub-step". */
function stepSummary(step: DraftStep) {
  const fields = plural(step.fields.length, "field", "fields");
  return step.subSteps.length > 0
    ? `${fields} · ${plural(step.subSteps.length, "sub-step", "sub-steps")}`
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
        {name || "Untitled sub-step"}
      </span>
      <Button type="button" size="xs" variant="outline" onClick={onOpen} disabled={disabled}>
        Edit
      </Button>
      <MoveRemove what={`sub-step ${name}`} place={place} disabled={disabled} />
    </div>
  );
}

/**
 * One step or sub-step: its name, instructions, fields, and sub-steps.
 * Sub-steps show as their titles and open in an editor of their own. A step in the list
 * of the workflow's steps moves and is removed here; a sub-step, from its parent.
 */
export function WorkflowStepEditor({
  step,
  inputSources,
  position,
  onChange,
  onOpenSubStep,
  disabled,
}: {
  readonly step: DraftStep;
  /** The fields of earlier steps it may read. */
  readonly inputSources: ReturnType<typeof inputSourcesFor>;
  /** Its place among the workflow's steps, with moving and removing it; null for a sub-step. */
  readonly position: Placement | null;
  readonly onChange: (step: DraftStep) => void;
  readonly onOpenSubStep: (key: string) => void;
  readonly disabled: boolean;
}) {
  // A sub-step's own editor is always open; a step in the list starts open only when new.
  const [startsOpen] = useState(position === null || step.name === "");
  const inputs = step.inputs ?? [];
  const inputKey = (input: (typeof inputs)[number]) => `${input.stepId}.${input.fieldId}`;
  const unboundSources = inputSources.filter(({ input }) => !inputs.some(isSameInput(input)));
  const title = (
    <Field label={position === null ? "Sub-step title" : "Step title"} size="xs">
      <Input
        placeholder="Collect documents, gather requirements, analyze request…"
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
              {step.name || "New step"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{stepSummary(step)}</span>
          </CollapsibleTrigger>
          <MoveRemove what={`step ${step.name}`} place={position} disabled={disabled} />
        </div>
      )}
      <CollapsiblePanel>
        <div className="flex flex-col gap-4 border-t border-border px-4 py-3.5">
          {position !== null ? title : null}
          <Field label="Instructions" size="xs">
            <Textarea
              placeholder="Guidance for a person, or the brief for an agent"
              value={step.instructions}
              onChange={(event) => onChange({ ...step, instructions: event.target.value })}
              disabled={disabled}
            />
          </Field>
          <hr />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Fields</span>
              <p className="text-xs text-muted-foreground">
                Data required to produce in this step.
              </p>
            </div>
            <FieldsEditor
              fields={step.fields}
              depth={0}
              onChange={(fields) => onChange({ ...step, fields })}
              disabled={disabled}
            />
          </div>
          <hr />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Inputs</span>
              <p className="text-xs text-muted-foreground">
                Fields of earlier steps this step reads. Whoever works on it sees nothing else of
                them.
              </p>
            </div>
            {inputs.map((input) => {
              const label =
                inputSources.find((source) => isSameInput(input)(source.input))?.label ??
                "A field that no earlier step has";
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
                    aria-label={`Remove input ${label}`}
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
              <SelectTrigger aria-label="Add input">
                <SelectValue placeholder="Add input" />
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
              <span className="text-xs font-medium text-muted-foreground">Automations</span>
              <p className="text-xs text-muted-foreground">
                What people can run on this step, in every project.
              </p>
            </div>
            <StepAutomationsEditor
              automationIds={step.automationIds ?? []}
              disabled={disabled}
              onChange={(automationIds) => onChange({ ...step, automationIds })}
            />
          </div>
          <hr />
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Sub-steps</span>
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
              label="Add sub-step"
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
