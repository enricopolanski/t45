import { Refused } from "@t45/contracts/models/Workflow";
import { AccessDenied } from "@t45/contracts/resources/errors";
import type { FieldValue as StepFieldValue, FieldView } from "@t45/contracts/resources/Workflows";
import { ChevronDownIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useId, useRef, useState } from "react";

import { attachmentUploadUrl, attachmentUrl, decodeUploadResult } from "../../lib/attachmentUrl";
import { api } from "../../rpc/api";
import { cn } from "../../lib/utils";
import { SavedInput, saveTyped } from "../SavedInput";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ErrorText } from "../ui/error-text";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { newKey } from "../workflows/workflowLogic";
import { CardFold } from "./CardFold";
import { formatDay, missingFields } from "./workLogic";

/** Uploads a file to the step; with `fieldKey`, it becomes that file field's value. */
export async function attachStepFile(stepId: string, file: File, fieldKey?: string) {
  const response = await fetch(
    attachmentUploadUrl({
      type: "file",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
    }),
    { method: "POST", body: file },
  );
  if (!response.ok) {
    throw response.status === 401
      ? new AccessDenied({ message: "Your session ended. Sign in again." })
      : new Refused({ reason: "invalid_attachment" });
  }
  const { attachmentId } = decodeUploadResult(await response.text());
  await api("workflows.attachStepFile", {
    stepId,
    attachmentId,
    ...(fieldKey === undefined ? {} : { fieldKey }),
  });
}

/** A download link for a step's file. */
function AttachmentLink({ attachment }: { readonly attachment: NonNullable<FieldView["file"]> }) {
  return (
    <a
      href={attachmentUrl(attachment)}
      download={attachment.name}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary hover:underline"
    >
      <PaperclipIcon className="size-3.5 shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </a>
  );
}

export function FilePickButton({
  label,
  disabled,
  onPick,
  ...input
}: ComponentProps<"input"> & {
  readonly label: string;
  readonly onPick: (file: File) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker}
        {...input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => picker.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}

function shownValue(field: FieldView) {
  if (field.value === null) return "Not filled in";
  switch (field.type) {
    case "boolean":
      return field.value === true ? "Yes" : "No";
    case "date":
      return typeof field.value === "string" ? formatDay(field.value) : String(field.value);
    default:
      return String(field.value);
  }
}

function FieldValue({ field }: { readonly field: FieldView }) {
  if (field.type === "group") {
    if (field.rows.length === 0)
      return <span className="text-sm text-muted-foreground">No entries</span>;
    return (
      <div className="flex flex-col gap-2">
        {field.rows.map((row) => (
          <div
            key={row.id ?? "row"}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <ReadOnlyFields fields={row.fields} />
          </div>
        ))}
      </div>
    );
  }
  if (field.type === "file") {
    return field.file === null ? (
      <span className="text-sm text-muted-foreground">No file</span>
    ) : (
      <AttachmentLink attachment={field.file} />
    );
  }
  return (
    <span
      className={
        field.value === null ? "text-sm text-muted-foreground" : "text-sm whitespace-pre-wrap"
      }
    >
      {shownValue(field)}
    </span>
  );
}

type EditorProps = {
  readonly field: FieldView;
  /** Paths of the fields to flag as still empty. */
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: StepFieldValue) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
};

/** A repeatable group's entries: rows with an id. */
type Entry = { readonly id: string; readonly fields: ReadonlyArray<FieldView> };

/** The field's stored value as an input holds it; a date input takes the day alone. */
const storedText = (field: FieldView) =>
  field.value === null
    ? ""
    : field.type === "date"
      ? String(field.value).slice(0, 10)
      : String(field.value);

/** What the field saves from what was typed into it: nothing, a number, or the text. */
const typedValue = (field: FieldView, typed: string): StepFieldValue =>
  typed === "" ? null : field.type === "number" ? Number(typed) : typed;

/** A field's input, framed; a group has none. */
function FieldControl({
  field,
  control,
  onSave,
  onUpload,
}: Omit<EditorProps, "missing"> & {
  readonly control: {
    readonly id: string;
    readonly "aria-describedby": string | undefined;
    readonly "aria-invalid": true | undefined;
  };
}) {
  const save = (value: StepFieldValue) => onSave(field.key, value);
  const saveText = (typed: string) => save(typedValue(field, typed));
  switch (field.type) {
    case "text":
      // One line tall at first, growing with what's written.
      return (
        <SavedInput
          {...control}
          multiline
          className="[&_textarea]:min-h-0 [&_textarea]:resize-none"
          value={storedText(field)}
          onSave={saveText}
        />
      );
    case "number":
    case "date":
      return (
        <SavedInput {...control} type={field.type} value={storedText(field)} onSave={saveText} />
      );
    case "select":
      return (
        <Select value={typeof field.value === "string" ? field.value : null} onValueChange={save}>
          <SelectTrigger {...control}>
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "boolean":
      return (
        <div className="flex h-9 items-center sm:h-8">
          <Switch {...control} checked={field.value === true} onCheckedChange={save} />
        </div>
      );
    case "file":
      return (
        <div className="flex min-h-9 flex-wrap items-center gap-3 sm:min-h-8">
          {field.file === null ? (
            <span className="text-sm text-muted-foreground">No file</span>
          ) : (
            <AttachmentLink attachment={field.file} />
          )}
          <FilePickButton
            {...control}
            label={field.file === null ? "Upload" : "Replace"}
            onPick={(file) => onUpload(field.key, file)}
          />
        </div>
      );
    case "group":
      return null;
  }
}

/**
 * A field with its label: beside the input, wrapping above it when narrow, or `isStacked` always
 * above it, as in an entry's form, where the guidance goes under the input so inputs side by side
 * line up. A group shows its own way.
 */
function FieldEditor({
  isStacked = false,
  ...props
}: EditorProps & {
  readonly isStacked?: boolean;
}) {
  const { field, missing } = props;
  const id = useId();
  if (field.type === "group") {
    return field.repeatable ? <EntriesEditor {...props} /> : <GroupEditor {...props} />;
  }
  const invalid = missing.has(field.key) || undefined;
  const describedBy =
    [field.description ? `${id}-description` : null, invalid ? `${id}-missing` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const guidance = field.description ? (
    <p id={`${id}-description`} className="text-xs text-muted-foreground">
      {field.description}
    </p>
  ) : null;
  return (
    <div
      data-field-key={field.key}
      className={
        isStacked ? "flex min-w-0 flex-col gap-1" : "flex flex-wrap items-start gap-x-4 gap-y-1"
      }
    >
      <div className={cn("flex min-w-0 flex-col gap-0.5", !isStacked && "grow basis-55 py-2")}>
        <Label htmlFor={id} size={isStacked ? "sm" : "default"}>
          {field.label}
        </Label>
        {!isStacked && guidance}
      </div>
      <div className={cn("flex min-w-0 flex-col gap-1", !isStacked && "grow-2 basis-70")}>
        <FieldControl
          {...props}
          control={{ id, "aria-describedby": describedBy, "aria-invalid": invalid }}
        />
        {isStacked && guidance}
        {invalid && <ErrorText id={`${id}-missing`} text="Required" />}
      </div>
    </div>
  );
}

/** Fields in order: one after another close together, and each group set apart. */
function FieldList({
  fields,
  ...props
}: Omit<EditorProps, "field"> & { readonly fields: ReadonlyArray<FieldView> }) {
  const runs: Array<Array<FieldView>> = [];
  for (const field of fields) {
    const run = runs.at(-1);
    if (field.type !== "group" && run?.[0]?.type !== "group" && run !== undefined) run.push(field);
    else runs.push([field]);
  }
  return (
    <div className="flex flex-col gap-5">
      {runs.map((run) => (
        <div key={run.map((field) => field.key).join()} className="flex flex-col gap-2">
          {run.map((field) => (
            <FieldEditor key={field.key} {...props} field={field} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A group's name and guidance, with `children` beside the name. */
function GroupHeading({
  field,
  children,
}: {
  readonly field: FieldView;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm/6 font-medium">{field.label}</h3>
        {children}
      </div>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

/** A group that doesn't repeat: its fields in a box under its name. */
function GroupEditor({ field, ...props }: EditorProps) {
  return (
    <div data-field-key={field.key} className="col-span-full flex flex-col gap-2">
      <GroupHeading field={field} />
      <div className="rounded-lg border p-3">
        <FieldList {...props} fields={field.rows.flatMap((row) => row.fields)} />
      </div>
    </div>
  );
}

function RemoveEntry({
  label,
  onRemove,
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) {
  return (
    <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onRemove}>
      <XIcon className="size-3" />
    </Button>
  );
}

/**
 * A repeatable group's entries, as a table or as a form each; entries holding a group only as
 * forms. Adding and removing entries saves the row ids; a removed entry's values go with it.
 */
function EntriesEditor(props: EditorProps) {
  const { field, missing, onSave } = props;
  const isTable = field.rowFields.every((child) => child.type !== "group");
  const [shown, setShown] = useState(isTable ? "table" : "form");
  const entries = field.rows.flatMap((row) =>
    row.id === null ? [] : [{ id: row.id, fields: row.fields }],
  );
  const ids = entries.map((entry) => entry.id);
  const remove = (at: number) => ({
    label: `Remove entry ${at + 1} of ${field.label}`,
    onRemove: () => onSave(field.key, ids.toSpliced(at, 1)),
  });
  return (
    <Tabs
      data-field-key={field.key}
      value={shown}
      onValueChange={setShown}
      className="col-span-full"
    >
      <div className="flex flex-col gap-2">
        <GroupHeading field={field}>
          <span className="text-xs text-muted-foreground">
            {entries.length === 1 ? "1 entry" : `${entries.length} entries`}
          </span>
          {isTable ? (
            <TabsList size="sm" aria-label={`Show ${field.label} as`} className="ml-auto">
              <TabsTab size="sm" value="table">
                Table
              </TabsTab>
              <TabsTab size="sm" value="form">
                Form
              </TabsTab>
            </TabsList>
          ) : null}
        </GroupHeading>
        {missing.has(field.key) && <ErrorText text="Add at least one entry" />}
        {entries.length > 0 ? (
          <>
            <TabsPanel value="table">
              <EntryTable {...props} entries={entries} remove={remove} />
            </TabsPanel>
            <TabsPanel value="form">
              <EntryForms {...props} entries={entries} remove={remove} />
            </TabsPanel>
          </>
        ) : null}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onSave(field.key, [...ids, newKey("row")])}
          >
            <PlusIcon />
            Add entry
          </Button>
        </div>
      </div>
    </Tabs>
  );
}

type EntriesProps = EditorProps & {
  readonly entries: ReadonlyArray<Entry>;
  readonly remove: (at: number) => { readonly label: string; readonly onRemove: () => void };
};

const headerCell =
  "border-l border-border/60 bg-muted px-1.5 py-2 text-left align-top text-xs font-medium text-foreground/80 wrap-break-word";

/** The entries as rows of a table, a column per field, typed into in place. */
function EntryTable({ field, entries, remove, missing, onSave, onUpload }: EntriesProps) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-xl table-fixed border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="w-8 bg-muted py-2 align-top text-xs font-medium text-muted-foreground"
            >
              #
            </th>
            {field.rowFields.map((child) => (
              <th
                key={child.id}
                scope="col"
                className={cn(headerCell, child.type === "number" && "text-right")}
              >
                {child.description ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="cursor-help underline decoration-dotted underline-offset-2" />
                      }
                    >
                      {child.label}
                    </TooltipTrigger>
                    <TooltipPopup>{child.description}</TooltipPopup>
                  </Tooltip>
                ) : (
                  child.label
                )}
              </th>
            ))}
            <th scope="col" className={cn(headerCell, "w-8")}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, at) => (
            <tr key={entry.id}>
              <td className="h-9 border-t text-center text-xs text-muted-foreground">{at + 1}</td>
              {entry.fields.map((child) => (
                <td
                  key={child.key}
                  data-field-key={child.key}
                  className="border-t border-l border-l-border/60 p-0 align-top has-aria-invalid:bg-destructive/8"
                >
                  <CellControl
                    field={child}
                    label={`${child.label}, entry ${at + 1}`}
                    isMissing={missing.has(child.key)}
                    onSave={onSave}
                    onUpload={onUpload}
                  />
                </td>
              ))}
              <td className="border-t border-l border-l-border/60 text-center">
                <RemoveEntry {...remove(at)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cellInput =
  "w-full bg-transparent px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** A field's input as a table cell holds it: unframed, named by `label`. */
function CellControl({
  field,
  label,
  isMissing,
  onSave,
  onUpload,
}: Omit<EditorProps, "missing"> & { readonly label: string; readonly isMissing: boolean }) {
  const control = { "aria-label": label, "aria-invalid": isMissing || undefined };
  const stored = storedText(field);
  const save = saveTyped(stored, (typed) => onSave(field.key, typedValue(field, typed)));
  switch (field.type) {
    case "text":
      return (
        <textarea
          key={stored}
          {...control}
          rows={1}
          defaultValue={stored}
          onBlur={save}
          className={cn(cellInput, "block min-h-9 resize-none py-2 field-sizing-content")}
        />
      );
    case "number":
    case "date":
      return (
        <input
          key={stored}
          {...control}
          type={field.type}
          defaultValue={stored}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(
            cellInput,
            "h-9",
            field.type === "number" &&
              "[appearance:textfield] text-right [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          )}
        />
      );
    case "select":
      return (
        <Select
          value={typeof field.value === "string" ? field.value : null}
          onValueChange={(value) => onSave(field.key, value)}
        >
          <SelectTrigger {...control} variant="cell">
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "boolean":
      return (
        <div className="flex h-9 items-center px-1.5">
          <Switch
            {...control}
            checked={field.value === true}
            onCheckedChange={(checked) => onSave(field.key, checked)}
          />
        </div>
      );
    case "file":
      return (
        <div className="flex min-h-9 flex-wrap items-center gap-2 px-1.5 py-1">
          {field.file === null ? null : <AttachmentLink attachment={field.file} />}
          <FilePickButton
            {...control}
            label={field.file === null ? "Upload" : "Replace"}
            onPick={(file) => onUpload(field.key, file)}
          />
        </div>
      );
    case "group":
      return null;
  }
}

/**
 * The entries as a form each, one open at a time; an entry with a field flagged as empty stays
 * open. An entry's header shows its first field's value and how many of its fields are filled.
 */
function EntryForms({ entries, remove, ...props }: EntriesProps) {
  const [openId, setOpenId] = useState(entries[0]?.id ?? null);
  return (
    <div className="divide-y overflow-hidden rounded-lg border">
      {entries.map((entry, at) => {
        const empty = missingFields(entry.fields);
        const filled = entry.fields.filter((child) => missingFields([child]).length === 0);
        const first = entry.fields[0];
        const title =
          first === undefined || first.type === "group" || first.value === null
            ? null
            : shownValue(first);
        return (
          <Collapsible
            key={entry.id}
            open={openId === entry.id || empty.some((child) => props.missing.has(child.key))}
            onOpenChange={(isOpen) => setOpenId(isOpen ? entry.id : null)}
          >
            <div className="flex items-center gap-1 bg-muted pr-2">
              <CollapsibleTrigger className="group flex min-h-10 min-w-0 flex-1 items-center gap-2 pr-2 pl-2.5 text-left text-sm">
                <ChevronDownIcon
                  aria-hidden
                  className="size-3.5 shrink-0 -rotate-90 text-muted-foreground transition-transform group-data-panel-open:rotate-0"
                />
                <span className="w-3.5 shrink-0 text-xs text-muted-foreground">{at + 1}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    title === null ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {title ?? "Untitled entry"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {filled.length} of {entry.fields.length} filled
                </span>
              </CollapsibleTrigger>
              <RemoveEntry {...remove(at)} />
            </div>
            <CollapsiblePanel>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] gap-3 border-t p-3">
                {entry.fields.map((child) => (
                  <FieldEditor key={child.key} {...props} field={child} isStacked />
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
    </div>
  );
}

/** The step's fields: editable by whoever works the step, read-only for everyone else. */
export function StepFields({
  fields,
  editable,
  missing,
  onSave,
  onUpload,
}: {
  readonly fields: ReadonlyArray<FieldView>;
  readonly editable: boolean;
  /** Paths of the fields to flag as still empty. */
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: StepFieldValue) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <CardFold title="Fields" held={missing.size > 0}>
      {editable ? (
        <FieldList fields={fields} missing={missing} onSave={onSave} onUpload={onUpload} />
      ) : (
        <ReadOnlyFields fields={fields} />
      )}
    </CardFold>
  );
}

/** Fields as text, for a step the viewer only reads; the parent's column spaces them. */
export function ReadOnlyFields({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  return fields.map((field) => (
    <div key={field.key} className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{field.label}</span>
      <FieldValue field={field} />
    </div>
  ));
}
