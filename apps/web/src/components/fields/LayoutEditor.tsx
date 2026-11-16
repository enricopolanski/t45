import type { Field, Layout } from "@t45/contracts/models/Field";
import { resolveFormLayout, resolveTableLayout } from "@t45/contracts/models/Layout";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { Field as LabeledField } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { FoldChevron } from "../work/CardFold";
import { FIELD_TYPES, moveEntry } from "../workflows/workflowLogic";
import { AddButton } from "./FieldsEditor";

type TableLayout = NonNullable<Layout["table"]>;
type FormLayout = NonNullable<Layout["form"]>;
type DialogWidth = NonNullable<FormLayout["dialogWidth"]>;
type Column = NonNullable<TableLayout["columns"]>[number];
type ColumnRow = { readonly field: Field; readonly column: Column; readonly isShown: boolean };

const WIDTHS = { auto: "Auto width", narrow: "Narrow", medium: "Medium", wide: "Wide" };
const SPANS = { third: "⅓ row", half: "½ row", "two-thirds": "⅔ row", full: "Full row" };
const DENSITIES = { compact: "Compact", normal: "Normal", relaxed: "Relaxed" };
const DIRECTIONS = { asc: "Ascending", desc: "Descending" };
const DIALOG_WIDTHS = { 768: "768 px", 1024: "1024 px", 1280: "1280 px" };

/** `part` with `key` set to `value`, or without `key` when `value` is undefined. */
export const withKey = <A extends object, K extends keyof A>(
  part: A,
  key: K,
  value: A[K] | undefined,
) => {
  const { [key]: _, ...rest } = part;
  return (value === undefined ? rest : { ...rest, [key]: value }) as A;
};

/** Text, a web address or a choice without tone icons can run long, so it can wrap. */
const canWrap = (field: Field) =>
  field.type === "text" ||
  field.type === "url" ||
  (field.type === "select" && Object.keys(field.tones ?? {}).length === 0);

/** A select of `choices` by their key, named by `label`. */
export function Choice<V extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: V;
  readonly choices: Readonly<Record<V, string>>;
  readonly onChange: (value: V) => void;
}) {
  const keys = Object.keys(choices).filter((key): key is V => key in choices);
  return (
    <Select
      value={value}
      onValueChange={(choice) => {
        const chosen = keys.find((key) => key === choice);
        if (chosen !== undefined) onChange(chosen);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto min-w-28">
        <SelectValue>{(choice: V) => choices[choice]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {keys.map((key) => (
          <SelectItem key={key} value={key}>
            {choices[key]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Up and down for a row of a list; `what` names it. */
export function MoveButtons({
  what,
  onMove,
  isFirst,
  isLast,
}: {
  readonly what: string;
  readonly onMove: (delta: -1 | 1) => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  return (
    <span className="flex shrink-0">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${what} up`}
        onClick={() => onMove(-1)}
        disabled={isFirst}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${what} down`}
        onClick={() => onMove(1)}
        disabled={isLast}
      >
        <ArrowDownIcon />
      </Button>
    </span>
  );
}

export function PanelSection({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </section>
  );
}

const settingRow = "flex-row items-center justify-between";

/**
 * The table's columns and rows: which fields show, in what order and how, and the sort. A hidden
 * field keeps its place and settings here while the layout lists only the shown ones.
 */
function TableSettings({
  fields,
  table,
  defaultColumns,
  rowsHint,
  onChange,
}: {
  readonly fields: ReadonlyArray<Field>;
  readonly table: TableLayout;
  readonly defaultColumns: ReadonlyArray<Field> | undefined;
  readonly rowsHint: string;
  readonly onChange: (table: TableLayout) => void;
}) {
  const resolved = resolveTableLayout(fields, { table }, defaultColumns);
  // Shown columns in their order, then the other fields.
  const [rows, setLocalRows] = useState<ReadonlyArray<ColumnRow>>(() => [
    ...resolved.columns.map(({ field }) => ({
      field,
      column: table.columns?.find((column) => column.field === field.id) ?? { field: field.id },
      isShown: true,
    })),
    ...fields
      .filter((field) => !resolved.columns.some((column) => column.field === field))
      .map((field) => ({ field, column: { field: field.id }, isShown: false })),
  ]);
  const setRows = (next: ReadonlyArray<ColumnRow>) => {
    setLocalRows(next);
    onChange({
      ...table,
      columns: next.filter((row) => row.isShown).map((row) => row.column),
    });
  };
  const setRow = (at: number, row: ColumnRow) => setRows(rows.with(at, row));
  const sortable = Object.fromEntries(
    fields
      .filter((field) => !["group", "records", "file"].includes(field.type))
      .map((field) => [field.id, field.label]),
  );
  const setSorts = (sortBy: NonNullable<TableLayout["sortBy"]>) =>
    onChange(withKey(table, "sortBy", sortBy.length === 0 ? undefined : sortBy));
  return (
    <>
      <PanelSection
        title="Columns"
        hint="Order, header, width and wrapping of each column. Hidden fields stay in the details."
      >
        <ol className="flex flex-col divide-y rounded-lg border">
          {rows.map((row, at) => {
            const { field, column } = row;
            return (
              <li key={field.id} className="flex flex-col gap-1.5 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <MoveButtons
                    what={field.label}
                    onMove={(delta) => setRows(moveEntry(rows, at, delta))}
                    isFirst={at === 0}
                    isLast={at === rows.length - 1}
                  />
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={row.isShown}
                      onCheckedChange={(isShown) => setRow(at, { ...row, isShown })}
                    />
                    <span className="truncate">{field.label}</span>
                  </label>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {FIELD_TYPES[field.type]}
                  </span>
                </div>
                {row.isShown ? (
                  <div className="flex flex-wrap items-center gap-1.5 pl-13">
                    <Input
                      size="sm"
                      aria-label={`Header of ${field.label}`}
                      placeholder={field.label}
                      value={column.header ?? ""}
                      onChange={(event) =>
                        setRow(at, {
                          ...row,
                          column: withKey(
                            column,
                            "header",
                            event.target.value.trim() === "" ? undefined : event.target.value,
                          ),
                        })
                      }
                      className="min-w-24 flex-1"
                    />
                    <Choice
                      label={`Width of ${field.label}`}
                      value={column.width ?? "auto"}
                      choices={WIDTHS}
                      onChange={(width) =>
                        setRow(at, {
                          ...row,
                          column: withKey(column, "width", width === "auto" ? undefined : width),
                        })
                      }
                    />
                    {canWrap(field) ? (
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={column.isWrapped === true}
                          onCheckedChange={(isWrapped) =>
                            setRow(at, {
                              ...row,
                              column: withKey(column, "isWrapped", isWrapped ? true : undefined),
                            })
                          }
                        />
                        Wrap
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </PanelSection>
      <PanelSection title="Rows" hint={rowsHint}>
        {resolved.sortBy.map((sort, at) => (
          <div key={sort.field} className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 text-xs text-muted-foreground">
              {at === 0 ? "Sort by" : "Then by"}
            </span>
            <Choice
              label={`Sort ${at + 1} field`}
              value={sort.field}
              // A field sorts once: the others' fields aren't offered.
              choices={Object.fromEntries(
                Object.entries(sortable).filter(
                  ([id]) =>
                    id === sort.field || !resolved.sortBy.some((other) => other.field === id),
                ),
              )}
              onChange={(field) => setSorts(resolved.sortBy.with(at, { ...sort, field }))}
            />
            <Choice
              label={`Sort ${at + 1} direction`}
              value={sort.direction}
              choices={DIRECTIONS}
              onChange={(direction) => setSorts(resolved.sortBy.with(at, { ...sort, direction }))}
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove sort ${at + 1}`}
              onClick={() => setSorts(resolved.sortBy.filter((_, other) => other !== at))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        {resolved.sortBy.length < 3 ? (
          <AddButton
            label={resolved.sortBy.length === 0 ? "Sort rows" : "Then sort by"}
            onClick={() => {
              const field = Object.keys(sortable).find(
                (id) => !resolved.sortBy.some((sort) => sort.field === id),
              );
              if (field !== undefined) setSorts([...resolved.sortBy, { field, direction: "asc" }]);
            }}
            disabled={Object.keys(sortable).length <= resolved.sortBy.length}
          />
        ) : null}
        <LabeledField label="Density" size="xs" className={settingRow}>
          <Choice
            label="Density"
            value={resolved.density}
            choices={DENSITIES}
            onChange={(density) =>
              onChange(withKey(table, "density", density === "normal" ? undefined : density))
            }
          />
        </LabeledField>
      </PanelSection>
    </>
  );
}

/** The form's fields, each with the part of a row it takes, its spacing and its dialog's width. */
function FormSettings({
  fields,
  form,
  defaultDialogWidth,
  onChange,
}: {
  readonly fields: ReadonlyArray<Field>;
  readonly form: FormLayout;
  readonly defaultDialogWidth: DialogWidth;
  readonly onChange: (form: FormLayout) => void;
}) {
  const resolved = resolveFormLayout(fields, { form });
  const setRows = (rows: ReadonlyArray<(typeof resolved.fields)[number]>) =>
    onChange({ ...form, fields: rows.map(({ field, span }) => ({ field: field.id, span })) });
  return (
    <>
      <PanelSection
        title="Fields"
        hint="Order and width of each field in the form and the details. Independent of the table."
      >
        <ol className="flex flex-col divide-y rounded-lg border">
          {resolved.fields.map((row, at) => (
            <li key={row.field.id} className="flex items-center gap-1.5 px-2 py-1.5">
              <MoveButtons
                what={row.field.label}
                onMove={(delta) => setRows(moveEntry(resolved.fields, at, delta))}
                isFirst={at === 0}
                isLast={at === resolved.fields.length - 1}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.field.label}</span>
              <Choice
                label={`Width of ${row.field.label} in the form`}
                value={row.span}
                choices={SPANS}
                onChange={(span) => setRows(resolved.fields.with(at, { ...row, span }))}
              />
            </li>
          ))}
        </ol>
      </PanelSection>
      <PanelSection title="Spacing and size">
        <LabeledField label="Spacing" size="xs" className={settingRow}>
          <Choice
            label="Spacing"
            value={resolved.spacing}
            choices={DENSITIES}
            onChange={(spacing) =>
              onChange(withKey(form, "spacing", spacing === "normal" ? undefined : spacing))
            }
          />
        </LabeledField>
        <LabeledField label="Dialog width" size="xs" className={settingRow}>
          <Choice
            label="Dialog width"
            value={String(resolved.dialogWidth ?? defaultDialogWidth)}
            choices={DIALOG_WIDTHS}
            onChange={(choice) => {
              const width = Number(choice) as DialogWidth;
              onChange(
                withKey(form, "dialogWidth", width === defaultDialogWidth ? undefined : width),
              );
            }}
          />
        </LabeledField>
      </PanelSection>
    </>
  );
}

/** `layout` with its `key` part replaced; an empty part, and an empty layout, are left out. */
export const withPart = <L extends Layout, K extends keyof L>(
  layout: L | undefined,
  key: K,
  part: L[K] | undefined,
) => {
  const isEmpty = typeof part === "object" && part !== null && Object.keys(part).length === 0;
  const next = withKey(layout ?? ({} as L), key, isEmpty ? undefined : part);
  return Object.keys(next).length === 0 ? undefined : next;
};

const NO_VIEWS: ReadonlyArray<never> = [];

/**
 * A further way the entries show, beside the table and the form: its `settings` edit the layout,
 * and its `preview` shows the entries, one entry when `isPerEntry`; `onOpen` shows an entry in
 * another view.
 */
export interface LayoutView<L> {
  readonly value: string;
  readonly label: string;
  readonly isPerEntry: boolean;
  readonly settings: (
    layout: L | undefined,
    onChange: (layout: L | undefined) => void,
  ) => ReactNode;
  readonly preview: (
    layout: L | undefined,
    entryId: string,
    onOpen: (entryId: string, view: string) => void,
  ) => ReactNode;
}

/**
 * Edits how a set of `fields` shows, in a dialog over the page: the table listing entries or
 * records and the form of one, beside a live preview of the real ones. The preview shows
 * `entries`, which `renderTable` lists and `renderForm` shows one of, as the working layout lays
 * them out; `previewNote`, while there is nothing to show, says why. `rowsHint` says what sorting
 * changes, and `saveNote` where a saved layout applies; `views` adds ways to show them. Saving
 * hands back the layout, undefined for none.
 */
export function LayoutEditor<L extends Layout>({
  trail,
  title,
  fields,
  layout: saved,
  defaultColumns,
  defaultDialogWidth,
  sourcePicker,
  entries,
  previewNote,
  rowsHint,
  saveNote,
  renderTable,
  renderForm,
  views = NO_VIEWS,
  isSaving,
  error,
  onSave,
  onClose,
}: {
  readonly trail: string;
  readonly title: string;
  readonly fields: ReadonlyArray<Field>;
  readonly layout: L | undefined;
  readonly defaultColumns?: ReadonlyArray<Field>;
  readonly defaultDialogWidth: DialogWidth;
  /** Where the preview's entries come from, when there is a choice. */
  readonly sourcePicker?: ReactNode;
  readonly entries: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly previewNote: string | null;
  readonly rowsHint: string;
  readonly saveNote?: string;
  readonly renderTable: (layout: L | undefined, onOpen: (entryId: string) => void) => ReactNode;
  readonly renderForm: (layout: L | undefined, entryId: string) => ReactNode;
  readonly views?: ReadonlyArray<LayoutView<L>>;
  readonly isSaving: boolean;
  readonly error: string | null;
  readonly onSave: (layout: L | undefined) => void;
  readonly onClose: () => void;
}) {
  const [layout, setLayout] = useState(saved);
  const [tab, setTab] = useState("table");
  // Reset starts the table's settings over, hidden columns included.
  const [resetCount, setResetCount] = useState(0);
  const [entryId, setEntryId] = useState<string | null>(null);
  const entry = entries.find(({ id }) => id === entryId) ?? entries[0];
  const dialogWidth = resolveFormLayout(fields, layout).dialogWidth ?? defaultDialogWidth;
  const view = views.find(({ value }) => value === tab);
  const open = (id: string, next: string) => {
    setEntryId(id);
    setTab(next);
  };
  return (
    <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <DialogPopup className="h-full max-w-none">
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b py-3 pr-14 pl-6">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">{trail}</span>
                <DialogTitle>{`Layout — ${title}`}</DialogTitle>
              </div>
              <div className="ml-auto flex items-center gap-4">
                {sourcePicker}
                <TabsList aria-label="Layout of">
                  <TabsTab value="table">Table</TabsTab>
                  <TabsTab value="form">Form</TabsTab>
                  {views.map(({ value, label }) => (
                    <TabsTab key={value} value={value}>
                      {label}
                    </TabsTab>
                  ))}
                </TabsList>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              <aside
                aria-label="Layout settings"
                className="flex flex-col gap-4 border-b p-4 lg:w-100 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
              >
                <TabsPanel value="table" keepMounted>
                  <div className="flex flex-col gap-4">
                    <TableSettings
                      key={resetCount}
                      fields={fields}
                      table={layout?.table ?? {}}
                      defaultColumns={defaultColumns}
                      rowsHint={rowsHint}
                      onChange={(table) => setLayout(withPart(layout, "table", table))}
                    />
                  </div>
                </TabsPanel>
                <TabsPanel value="form">
                  <div className="flex flex-col gap-4">
                    <FormSettings
                      fields={fields}
                      form={layout?.form ?? {}}
                      defaultDialogWidth={defaultDialogWidth}
                      onChange={(form) => setLayout(withPart(layout, "form", form))}
                    />
                  </div>
                </TabsPanel>
                {views.map(({ value, settings }) => (
                  <TabsPanel key={value} value={value}>
                    <div className="flex flex-col gap-4">{settings(layout, setLayout)}</div>
                  </TabsPanel>
                ))}
                {(tab === "form" || view?.isPerEntry === true) &&
                entries.length > 0 &&
                entry !== undefined ? (
                  <LabeledField label="Preview entry" size="xs" className={settingRow}>
                    <Choice
                      label="Preview entry"
                      value={entry.id}
                      choices={Object.fromEntries(entries.map(({ id, label }) => [id, label]))}
                      onChange={setEntryId}
                    />
                  </LabeledField>
                ) : null}
                <div className="border-t pt-3">
                  <Collapsible>
                    <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FoldChevron />
                      Stored as the layout
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2.5 text-xs whitespace-pre-wrap">
                        {layout === undefined
                          ? "No layout: the defaults."
                          : JSON.stringify(layout, null, 2)}
                      </pre>
                    </CollapsiblePanel>
                  </Collapsible>
                </div>
                {error && <ErrorText text={error} />}
                {saveNote ? <p className="text-xs text-muted-foreground">{saveNote}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setLayout(undefined);
                      setResetCount((count) => count + 1);
                    }}
                  >
                    Reset
                  </Button>
                  <Button type="button" onClick={() => onSave(layout)} disabled={isSaving}>
                    Save layout
                  </Button>
                </div>
              </aside>
              <section
                aria-label="Preview"
                className="flex min-w-0 flex-1 flex-col gap-3 p-4 lg:overflow-y-auto"
              >
                {previewNote !== null || entry === undefined ? (
                  <p className="text-sm text-muted-foreground">
                    {previewNote ?? "Nothing to show."}
                  </p>
                ) : tab === "table" ? (
                  renderTable(layout, (id) => open(id, "form"))
                ) : view !== undefined ? (
                  view.preview(layout, entry.id, open)
                ) : (
                  <div
                    role="group"
                    aria-label={`${title} — ${entry.label}`}
                    className="mx-auto flex w-full flex-col gap-4 rounded-2xl border bg-card p-6 shadow-sm"
                    style={{ maxWidth: `${dialogWidth}px` }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold">{`${title} — ${entry.label}`}</h3>
                      <span className="text-xs text-muted-foreground">Preview</span>
                    </div>
                    {renderForm(layout, entry.id)}
                  </div>
                )}
              </section>
            </div>
          </div>
        </Tabs>
      </DialogPopup>
    </Dialog>
  );
}
