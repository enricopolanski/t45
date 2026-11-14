import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { useRowKeys } from "../../hooks/useRowKeys";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FoldChevron } from "../work/CardFold";
import { plural } from "../work/workLogic";
import {
  blankField,
  type DraftField,
  FIELD_TYPES,
  type FieldType,
  listEntries,
  retypeField,
  withOptions,
} from "../workflows/workflowLogic";

export type Placed<A> = ReturnType<typeof listEntries<A>>[number];

export type Placement = Pick<Placed<unknown>, "index" | "first" | "last" | "move" | "remove">;

export function AddButton({
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
export function MoveRemove({
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

/** Fields as a step or a collection defines them, with a way to add one; `depth` counts the groups around them. */
export function FieldsEditor({
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

const NO_DEFAULT = "";

/**
 * What the field holds when a step starts, or a group's entry is added: none for files and groups.
 * Empty means no default.
 */
function DefaultValueInput({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  if (field.type === "group" || field.type === "file") return null;
  const { defaultValue, ...rest } = field;
  const set = (value: string | number | boolean | null) =>
    onChange(value === null ? rest : { ...rest, defaultValue: value });
  const choices =
    field.type === "boolean"
      ? [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]
      : field.type === "select"
        ? field.options
            .map((option) => option.trim())
            .filter((option) => option !== "")
            .map((option) => ({ value: option, label: option }))
        : null;
  return (
    <Field label="Default value" size="xs">
      {choices === null ? (
        <Input
          type={field.type}
          placeholder="Optional"
          value={defaultValue === undefined ? "" : String(defaultValue)}
          onChange={(event) => {
            const typed = event.target.value;
            set(typed === "" ? null : field.type === "number" ? Number(typed) : typed);
          }}
          disabled={disabled}
        />
      ) : (
        <Select
          value={defaultValue === undefined ? NO_DEFAULT : String(defaultValue)}
          onValueChange={(choice) =>
            set(
              choice === NO_DEFAULT || choice === null
                ? null
                : field.type === "boolean"
                  ? choice === "true"
                  : choice,
            )
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue>
              {(choice: string) =>
                choices.find((option) => option.value === choice)?.label ?? "None"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_DEFAULT}>None</SelectItem>
            {choices.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </Field>
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
                {listEntries(field.options, (options) => setField(withOptions(field, options))).map(
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
                <FieldsEditor
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
            <DefaultValueInput field={field} onChange={setField} disabled={disabled} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
