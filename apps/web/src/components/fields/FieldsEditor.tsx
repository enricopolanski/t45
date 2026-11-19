import { type Message, type Translate, useTranslation } from "~/i18n/locale";
import { FieldTone } from "@t45/contracts/models/Field";
import { isTableColumn } from "@t45/contracts/models/Layout";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { useRowKeys } from "../../hooks/useRowKeys";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FoldChevron } from "../work/CardFold";
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
  const t = useTranslation();
  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("Move {0} up", what)}
        onClick={() => place.move(-1)}
        disabled={disabled || place.first}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("Move {0} down", what)}
        onClick={() => place.move(1)}
        disabled={disabled || place.last}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("Remove {0}", what)}
        onClick={place.remove}
        disabled={disabled}
      >
        <XIcon />
      </Button>
    </>
  );
}

/** Whether a field shows as a column of the table listing its entries or records. */
export function ColumnSwitch({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type === "url" && field.displayLinkOn !== undefined) return null;
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch
        size="sm"
        checked={isTableColumn(field)}
        onCheckedChange={(checked) => {
          const { isDetailOnly: _, ...rest } = field;
          onChange(checked ? rest : { ...rest, isDetailOnly: true });
        }}
        disabled={disabled}
      />
      {t("Show in table")}
    </label>
  );
}

/** How a text field is read; its original source stays editable. */
export function MarkdownSwitch({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type !== "text") return null;
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch
        size="sm"
        checked={field.isMarkdown === true}
        onCheckedChange={(checked) => {
          const { isMarkdown: _, ...rest } = field;
          onChange(checked ? { ...rest, isMarkdown: true } : rest);
        }}
        disabled={disabled}
      />
      {t("Render as Markdown")}
    </label>
  );
}

/** Whether agents only propose the field's value, for a member to approve; never a group's or file's. */
function ReviewSwitch({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type === "group" || field.type === "file") return null;
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch
        size="sm"
        checked={field.isReviewed === true}
        onCheckedChange={(checked) => {
          const { isReviewed: _, ...rest } = field;
          onChange(checked ? { ...rest, isReviewed: true } : rest);
        }}
        disabled={disabled}
      />
      {t("Agents propose, members approve")}
    </label>
  );
}

/** The other field whose value opens this URL. All sibling field types can display the link. */
export function LinkDisplaySelect({
  field,
  fields,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly fields: ReadonlyArray<DraftField>;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type !== "url") return null;
  const choices = fields.filter((other) => other.id !== field.id);
  return (
    <Field label={t("Display link on")} size="xs">
      <Select
        value={field.displayLinkOn ?? ""}
        onValueChange={(target) => {
          const { displayLinkOn: _, ...rest } = field;
          onChange(target ? { ...rest, displayLinkOn: target } : rest);
        }}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue>
            {(target: string) =>
              target === ""
                ? t("Own field")
                : choices.find(({ id }) => id === target)?.label || t("Untitled field")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="">{t("Own field")}</SelectItem>
          {choices.map((other) => (
            <SelectItem key={other.id} value={other.id}>
              {other.label || t("Untitled field")}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

const AS_ENTERED = "";

/** How many decimal places a number field shows; values stay as entered. */
function DecimalsSelect({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type !== "number") return null;
  const { decimals, ...rest } = field;
  return (
    <Field label={t("Decimals")} size="xs">
      <Select
        value={decimals === undefined ? AS_ENTERED : String(decimals)}
        onValueChange={(choice) =>
          onChange(
            choice === AS_ENTERED || choice === null ? rest : { ...rest, decimals: Number(choice) },
          )
        }
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue>
            {(choice: string) => (choice === AS_ENTERED ? t("As entered") : choice)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={AS_ENTERED}>{t("As entered")}</SelectItem>
          {["0", "1", "2", "3", "4", "5", "6"].map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

/** What a number field counts in, shown after its values. */
function UnitInput({
  field,
  onChange,
  disabled,
}: {
  readonly field: DraftField;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  if (field.type !== "number") return null;
  const { unit, ...rest } = field;
  return (
    <Field label={t("Unit")} size="xs">
      <Input
        placeholder="%, €, kg"
        value={unit ?? ""}
        onChange={(event) =>
          onChange(event.target.value.trim() === "" ? rest : { ...rest, unit: event.target.value })
        }
        disabled={disabled}
      />
    </Field>
  );
}

const NO_TONE = "";

const TONE_LABELS: Record<string, Message> = {
  [NO_TONE]: "No tone",
  positive: "Positive",
  neutral: "Neutral",
  warning: "Warning",
  negative: "Negative",
};

/** How a select's option reads at a glance: tables show an option with a tone as its icon. */
function ToneSelect({
  field,
  option,
  onChange,
  disabled,
}: {
  readonly field: Extract<DraftField, { type: "select" }>;
  readonly option: string;
  readonly onChange: (field: DraftField) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const { tones = {}, ...rest } = field;
  const { [option.trim()]: tone, ...others } = tones;
  return (
    <Select
      value={tone ?? NO_TONE}
      onValueChange={(choice) => {
        const chosen = FieldTone.literals.find((candidate) => candidate === choice);
        const next = chosen === undefined ? others : { ...others, [option.trim()]: chosen };
        onChange(Object.keys(next).length === 0 ? rest : { ...rest, tones: next });
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={t("Tone of option {0}", option)} className="min-w-28">
        <SelectValue>
          {(choice: string) => {
            const message = TONE_LABELS[choice];
            return message === undefined ? "" : t(message);
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(TONE_LABELS).map(([choice, label]) => (
          <SelectItem key={choice} value={choice}>
            {t(label)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A collection a records field can link. */
export type LinkableCollection = { readonly id: string; readonly title: string };

type ComparisonFieldsControl = (
  field: Extract<DraftField, { type: "records" }>,
  onChange: (field: DraftField) => void,
) => ReactNode;

/** A way to edit a repeatable group's layout, shown with its fields. */
type GroupLayoutControl = (
  group: Extract<DraftField, { type: "group" }>,
  onChange: (group: DraftField) => void,
) => ReactNode;

/**
 * Fields as a step or a collection defines them, with a way to add one; `depth` counts the groups
 * around them. `areColumns` when a table lists them, each a column but `keyFieldId`'s, which
 * always is one. With `collections`, a field can link records of one of them. With
 * `groupLayout`, a repeatable group's layout is edited there. `areReviewable` on a step, whose
 * fields agents can be made to only propose.
 */
export function FieldsEditor({
  fields,
  siblings = fields,
  depth,
  areColumns,
  keyFieldId,
  collections,
  groupLayout,
  comparisonFieldsEditor,
  areReviewable = false,
  onChange,
  disabled,
}: {
  readonly fields: ReadonlyArray<DraftField>;
  readonly siblings?: ReadonlyArray<DraftField>;
  readonly depth: number;
  readonly areColumns: boolean;
  readonly keyFieldId?: string;
  readonly collections?: ReadonlyArray<LinkableCollection>;
  readonly groupLayout?: GroupLayoutControl | undefined;
  readonly comparisonFieldsEditor?: ComparisonFieldsControl | undefined;
  readonly areReviewable?: boolean;
  readonly onChange: (fields: ReadonlyArray<DraftField>) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  return (
    <>
      {listEntries(fields, onChange).map((place) => (
        <FieldCard
          key={place.entry.id}
          place={place}
          siblings={siblings}
          depth={depth}
          isColumn={areColumns && place.entry.id !== keyFieldId}
          collections={collections}
          groupLayout={groupLayout}
          comparisonFieldsEditor={comparisonFieldsEditor}
          isReviewable={areReviewable}
          disabled={disabled}
        />
      ))}
      <AddButton
        label={t("Add field")}
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
  const t = useTranslation();
  if (field.type === "group" || field.type === "file" || field.type === "records") return null;
  const { defaultValue, ...rest } = field;
  const set = (value: string | number | boolean | null) =>
    onChange(value === null ? rest : { ...rest, defaultValue: value });
  const choices =
    field.type === "boolean"
      ? [
          { value: "true", label: t("Yes") },
          { value: "false", label: t("No") },
        ]
      : field.type === "select"
        ? field.options
            .map((option) => option.trim())
            .filter((option) => option !== "")
            .map((option) => ({ value: option, label: option }))
        : null;
  return (
    <Field label={t("Default value")} size="xs">
      {choices === null ? (
        <Input
          type={field.type}
          placeholder={t("Optional")}
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
                choices.find((option) => option.value === choice)?.label ?? t("None")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_DEFAULT}>{t("None")}</SelectItem>
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
function fieldSummary(field: DraftField, t: Translate) {
  if (field.type === "select") {
    return `${t(FIELD_TYPES.select)} · ${t(field.options.length === 1 ? "{0} option" : "{0} options", field.options.length)}`;
  }
  if (field.type === "group") {
    const fields = t(field.fields.length === 1 ? "{0} field" : "{0} fields", field.fields.length);
    return `${t(FIELD_TYPES.group)} · ${fields}${field.repeatable ? ` · ${t("Multiple entries")}` : ""}`;
  }
  return t(FIELD_TYPES[field.type]);
}

/**
 * A field summary row that opens to edit it; a new, unlabelled field starts open. A group lists
 * its own fields, and a group inside a group can't hold a group. A field links records only where
 * `collections` are offered.
 */
function FieldCard({
  place,
  siblings,
  depth,
  isColumn,
  collections,
  groupLayout,
  comparisonFieldsEditor,
  isReviewable,
  disabled,
}: {
  readonly place: Placed<DraftField>;
  readonly siblings: ReadonlyArray<DraftField>;
  readonly depth: number;
  readonly isColumn: boolean;
  readonly collections: ReadonlyArray<LinkableCollection> | undefined;
  readonly groupLayout: GroupLayoutControl | undefined;
  readonly comparisonFieldsEditor: ComparisonFieldsControl | undefined;
  readonly isReviewable: boolean;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
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
              {field.label || t("New field")}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{fieldSummary(field, t)}</span>
          </CollapsibleTrigger>
          <MoveRemove what={t("field {0}", field.label)} place={place} disabled={disabled} />
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 border-t border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("Label")} size="xs" className="min-w-40 flex-1">
                <Input
                  placeholder={t("Total")}
                  value={field.label}
                  autoFocus={field.label === ""}
                  onChange={(event) => setField({ ...field, label: event.target.value })}
                  disabled={disabled}
                />
              </Field>
              <Field label={t("Type")} size="xs">
                <Select
                  value={field.type}
                  onValueChange={(type) => setField(retypeField(field, type as FieldType))}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue>{(type: FieldType) => t(FIELD_TYPES[type])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(FIELD_TYPES)
                      .filter(
                        ([type]) =>
                          (type !== "group" || depth < 2) &&
                          (type !== "records" || collections !== undefined),
                      )
                      .map(([type, label]) => (
                        <SelectItem key={type} value={type}>
                          {t(label)}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <LinkDisplaySelect
              field={field}
              fields={siblings}
              onChange={setField}
              disabled={disabled}
            />
            {field.type === "select" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">{t("Options")}</span>
                {listEntries(field.options, (options) => setField(withOptions(field, options))).map(
                  (option) => (
                    <div key={optionRows.keys[option.index]} className="flex items-center gap-1.5">
                      <Input
                        aria-label={t("Option {0}", option.index + 1)}
                        placeholder={[t("Approved"), t("Declined")][option.index]}
                        value={option.entry}
                        onChange={(event) => option.replace(event.target.value)}
                        autoFocus={!option.first && option.last && !option.entry}
                        disabled={disabled}
                        className="min-w-0 flex-1"
                      />
                      <ToneSelect
                        field={field}
                        option={option.entry}
                        onChange={setField}
                        disabled={disabled}
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("Remove option {0}", option.entry)}
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
                  label={t("Add option")}
                  onClick={() => setField({ ...field, options: [...field.options, ""] })}
                  disabled={disabled}
                />
              </div>
            ) : null}
            {field.type === "records" ? (
              <Field label={t("Collection")} size="xs">
                <Select
                  value={field.collectionId === "" ? null : field.collectionId}
                  onValueChange={(collectionId) =>
                    collectionId === null ? undefined : setField({ ...field, collectionId })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(collectionId: string | null) =>
                        collectionId === null
                          ? t("Choose one")
                          : (collections?.find(({ id }) => id === collectionId)?.title ??
                            collectionId)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {collections?.map((collection) => (
                      <SelectItem key={collection.id} value={collection.id}>
                        {collection.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : null}
            {field.type === "group" ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <Switch
                    id={`${id}-repeatable`}
                    aria-describedby={`${id}-repeatable-hint`}
                    size="sm"
                    checked={field.repeatable === true}
                    onCheckedChange={(checked) => {
                      const { recordReview: _, ...rest } = field;
                      setField(
                        checked ? { ...field, repeatable: true } : { ...rest, repeatable: false },
                      );
                    }}
                    disabled={disabled}
                  />
                  <div className="flex flex-col gap-0.5">
                    <label htmlFor={`${id}-repeatable`} className="text-xs font-medium">
                      {t("Multiple entries")}
                    </label>
                    <p id={`${id}-repeatable-hint`} className="text-xs text-muted-foreground">
                      {t("e.g. product variants, transactions, colors, etc.")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{t("Fields")}</span>
                  {field.repeatable ? groupLayout?.(field, setField) : null}
                </div>
                <FieldsEditor
                  fields={field.fields}
                  depth={depth + 1}
                  // A layout's columns replace "Show in table".
                  areColumns={
                    field.repeatable === true && field.layout?.table?.columns === undefined
                  }
                  // Only a step's own repeatable groups preview a ticket's entries.
                  groupLayout={field.repeatable ? undefined : groupLayout}
                  comparisonFieldsEditor={comparisonFieldsEditor}
                  areReviewable={isReviewable}
                  onChange={(fields) => setField({ ...field, fields })}
                  disabled={disabled}
                />
              </div>
            ) : null}
            <Field label={t("Description")} size="xs">
              <Input
                placeholder={t("Optional")}
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
            <MarkdownSwitch field={field} onChange={setField} disabled={disabled} />
            {isReviewable ? (
              <ReviewSwitch field={field} onChange={setField} disabled={disabled} />
            ) : null}
            {isReviewable && field.type === "records" && field.isReviewed
              ? comparisonFieldsEditor?.(field, setField)
              : null}
            {field.type === "number" ? (
              <div className="flex flex-wrap items-end gap-2">
                <DecimalsSelect field={field} onChange={setField} disabled={disabled} />
                <UnitInput field={field} onChange={setField} disabled={disabled} />
              </div>
            ) : null}
            {isColumn ? (
              <ColumnSwitch field={field} onChange={setField} disabled={disabled} />
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
