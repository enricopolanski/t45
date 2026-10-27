import type { DraftField, FieldType, DraftStep } from "./workflowLogic";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { useRowKeys } from "../../hooks/useRowKeys";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { FoldChevron } from "../work/CardFold";
import { plural } from "../work/workLogic";
import { blankField, blankStep, FIELD_TYPES, listEntries, retypeField } from "./workflowLogic";

type Placed<A> = ReturnType<typeof listEntries<A>>[number];

type Placement = Pick<Placed<unknown>, "index" | "first" | "last" | "move" | "remove">;

function AddButton({
  label,
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div>
      <Button type="button" size="xs" variant="ghost" onClick={onClick} disabled={disabled}>
        <PlusIcon />
        {label}
      </Button>
    </div>
  );
}

/** Up, down, and remove for an entry of a list; `what` names it, as in "field Total". */
function MoveRemove({
  what,
  place,
  disabled,
}: {
  readonly what: string;
  readonly place: Placement;
  readonly disabled: boolean;
}) {
  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Move ${what} up`}
        onClick={() => place.move(-1)}
        disabled={disabled || place.first}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Move ${what} down`}
        onClick={() => place.move(1)}
        disabled={disabled || place.last}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${what}`}
        onClick={place.remove}
        disabled={disabled}
      >
        <XIcon />
      </Button>
    </>
  );
}

/** Fields with a way to add one; `depth` counts the groups around them. */
function FieldList({
  fields,
  depth,
  onChange,
  disabled,
}: {
  readonly fields: ReadonlyArray<DraftField>;
  readonly depth: number;
  readonly onChange: (fields: ReadonlyArray<DraftField>) => void;
  readonly disabled: boolean;
}) {
  return (
    <>
      {listEntries(fields, onChange).map((place) => (
        <FieldCard key={place.entry.id} place={place} depth={depth} disabled={disabled} />
      ))}
      <AddButton
        label="Add field"
        onClick={() => onChange([...fields, blankField()])}
        disabled={disabled}
      />
    </>
  );
}

/** What a field's collapsed row says after its label. */
function fieldSummary(field: DraftField) {
  if (field.type === "select") {
    return `${FIELD_TYPES.select} · ${plural(field.options.length, "option", "options")}`;
  }
  if (field.type === "group") {
    const fields = plural(field.fields.length, "field", "fields");
    return `${FIELD_TYPES.group} · ${fields}${field.repeatable ? " · multiple entries" : ""}`;
  }
  return FIELD_TYPES[field.type];
}

/** What a step holds, shown beside its title, e.g. "5 fields · 1 sub-step". */
function stepSummary(step: DraftStep) {
  const fields = plural(step.fields.length, "field", "fields");
  return step.subSteps.length > 0
    ? `${fields} · ${plural(step.subSteps.length, "sub-step", "sub-steps")}`
    : fields;
}

/**
 * A field summary row that opens to edit it; a new, unlabelled field starts open. A group lists
 * its own fields, and a group inside a group can't hold a group.
 */
function FieldCard({
  place,
  depth,
  disabled,
}: {
  readonly place: Placed<DraftField>;
  readonly depth: number;
  readonly disabled: boolean;
}) {
  const id = useId();
  const { entry: field, replace: setField } = place;
  const [startsOpen] = useState(field.label === "");
  const optionRows = useRowKeys(field.type === "select" ? field.options.length : 0);
  return (
    <div className="rounded-lg border border-border">
      <Collapsible defaultOpen={startsOpen}>
        <div className="flex items-center gap-2 px-3 py-2">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left">
            <FoldChevron />
            <span
              className={
                field.label
                  ? "truncate text-sm font-medium"
                  : "truncate text-sm text-muted-foreground"
              }
            >
              {field.label || "New field"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{fieldSummary(field)}</span>
          </CollapsibleTrigger>
          <MoveRemove what={`field ${field.label}`} place={place} disabled={disabled} />
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 border-t border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Label" size="xs" className="min-w-40 flex-1">
                <Input
                  placeholder="Total"
                  value={field.label}
                  autoFocus={field.label === ""}
                  onChange={(event) => setField({ ...field, label: event.target.value })}
                  disabled={disabled}
                />
              </Field>
              <Field label="Type" size="xs">
                <Select
                  value={field.type}
                  onValueChange={(type) => setField(retypeField(field, type as FieldType))}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue>{(type: FieldType) => FIELD_TYPES[type]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(FIELD_TYPES)
                      .filter(([type]) => type !== "group" || depth < 2)
                      .map(([type, label]) => (
                        <SelectItem key={type} value={type}>
                          {label}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            {field.type === "select" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Options</span>
                {listEntries(field.options, (options) => setField({ ...field, options })).map(
                  (option) => (
                    <div key={optionRows.keys[option.index]} className="flex items-center gap-1.5">
                      <Input
                        aria-label={`Option ${option.index + 1}`}
                        placeholder={["Approved", "Declined"][option.index]}
                        value={option.entry}
                        onChange={(event) => option.replace(event.target.value)}
                        autoFocus={!option.first && option.last && !option.entry}
                        disabled={disabled}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove option ${option.entry}`}
                        onClick={() => {
                          optionRows.remove(option.index);
                          option.remove();
                        }}
                        disabled={disabled}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ),
                )}
                <AddButton
                  label="Add option"
                  onClick={() => setField({ ...field, options: [...field.options, ""] })}
                  disabled={disabled}
                />
              </div>
            ) : null}
            {field.type === "group" ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <Switch
                    id={`${id}-repeatable`}
                    aria-describedby={`${id}-repeatable-hint`}
                    size="sm"
                    checked={field.repeatable === true}
                    onCheckedChange={(checked) => setField({ ...field, repeatable: checked })}
                    disabled={disabled}
                  />
                  <div className="flex flex-col gap-0.5">
                    <label htmlFor={`${id}-repeatable`} className="text-xs font-medium">
                      Multiple entries
                    </label>
                    <p id={`${id}-repeatable-hint`} className="text-xs text-muted-foreground">
                      e.g. product variants, transactions, colors, etc.
                    </p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Fields</span>
                <FieldList
                  fields={field.fields}
                  depth={depth + 1}
                  onChange={(fields) => setField({ ...field, fields })}
                  disabled={disabled}
                />
              </div>
            ) : null}
            <Field label="Description" size="xs">
              <Input
                placeholder="Optional"
                value={field.description ?? ""}
                onChange={(event) => {
                  const { description: _, ...rest } = field;
                  setField(
                    event.target.value ? { ...rest, description: event.target.value } : rest,
                  );
                }}
                disabled={disabled}
              />
            </Field>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
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
  position,
  onChange,
  onOpenSubStep,
  disabled,
}: {
  readonly step: DraftStep;
  /** Its place among the workflow's steps, with moving and removing it; null for a sub-step. */
  readonly position: Placement | null;
  readonly onChange: (step: DraftStep) => void;
  readonly onOpenSubStep: (key: string) => void;
  readonly disabled: boolean;
}) {
  // A sub-step's own editor is always open; a step in the list starts open only when new.
  const [startsOpen] = useState(position === null || step.name === "");
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
            <FieldList
              fields={step.fields}
              depth={0}
              onChange={(fields) => onChange({ ...step, fields })}
              disabled={disabled}
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
