import { useTranslation, translate } from "~/i18n/locale";
import { Refused } from "@t45/contracts/models/Workflow";
import type { Collection } from "@t45/contracts/models/Collection";
import {
  defaultValues,
  type Field,
  type FieldValues,
  isUrlFieldValue,
  type Layout,
  recordKeys,
} from "@t45/contracts/models/Field";
import {
  resolveFormLayout,
  resolveTableLayout,
  sortRows,
  type TableColumn,
} from "@t45/contracts/models/Layout";
import { AccessDenied } from "@t45/contracts/resources/errors";
import type { FieldValue as StepFieldValue, FieldView } from "@t45/contracts/resources/Workflows";
import { ChevronDownIcon, LinkIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useId, useRef, useState } from "react";

import { attachmentUploadUrl, attachmentUrl, decodeUploadResult } from "../../lib/attachmentUrl";
import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { cn } from "../../lib/utils";
import { RecordShowcase } from "../collections/RecordDisplay";
import { RecordDialog, RecordLink, RecordPicker, RecordTable } from "../collections/Records";
import { SavedInput, saveTyped } from "../SavedInput";
import { ExternalUrl } from "../ExternalUrl";
import {
  measureColumnWidth,
  CONTROL_CELL_DENSITY,
  FORM_SPANS,
  FORM_GRIDS,
} from "../fields/fieldPresentation";
import { OneLineValue } from "../fields/OneLineValue";
import { MarkdownInput } from "../fields/MarkdownInput";
import { MarkdownText } from "../markdown/MarkdownText";
import { OptionValue } from "../fields/OptionValue";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { newKey } from "../workflows/workflowLogic";
import { CardFold } from "./CardFold";
import { ReadOnlyForm } from "./StepInputs";
import { formatDay, formatNumber, missingFields } from "./workLogic";

/** Uploads a file as the member's pending attachment, ready to be given to a field; answers its id. */
export async function uploadFile(file: File) {
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
      ? new AccessDenied({ message: translate("Your session ended. Sign in again.") })
      : new Refused({ reason: "invalid_attachment" });
  }
  return decodeUploadResult(await response.text()).attachmentId;
}

/** Uploads a file to the step; with `fieldKey`, it becomes that file field's value. */
export async function attachStepFile(stepId: string, file: File, fieldKey?: string) {
  await api("workflows.attachStepFile", {
    stepId,
    attachmentId: await uploadFile(file),
    ...(fieldKey === undefined ? {} : { fieldKey }),
  });
}

/** A download link for a step's file. */
export function AttachmentLink({
  attachment,
}: {
  readonly attachment: NonNullable<FieldView["file"]>;
}) {
  return (
    <a
      href={attachmentUrl(attachment)}
      download={attachment.name}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary hover:underline"
    >
      <PaperclipIcon className="size-3.5 shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </a>
  );
}

function FilePickButton({
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

export function shownValue(field: FieldView) {
  if (field.type === "file") return field.file?.name ?? field.label;
  if (field.type === "group" || field.type === "records") return field.label;
  if (field.value === null) return translate("Not filled in");
  switch (field.type) {
    case "boolean":
      return field.value === true ? translate("Yes") : translate("No");
    case "date":
      return typeof field.value === "string" ? formatDay(field.value) : String(field.value);
    case "number":
      return typeof field.value === "number"
        ? formatNumber(field.value, field)
        : String(field.value);
    default:
      return Array.isArray(field.value) ? field.value.join(", ") : String(field.value);
  }
}

export function FieldValue({ field }: { readonly field: FieldView }) {
  const t = useTranslation();
  if (field.linkUrl !== undefined && field.type !== "group" && field.type !== "records")
    return <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>;
  if (field.type === "records") {
    return field.collection === null || field.records.length === 0 ? (
      <span className="text-sm text-muted-foreground">{t("No records")}</span>
    ) : (
      <RecordTable label={field.label} collection={field.collection} records={field.records} />
    );
  }
  if (field.type === "group") {
    if (field.rows.length === 0)
      return <span className="text-sm text-muted-foreground">{t("No entries")}</span>;
    return (
      <div className="flex flex-col gap-2">
        {field.repeatable
          ? sortEntries(field).map((entry) => (
              <div key={entry.id} className="rounded-lg border border-border p-3">
                <ReadOnlyForm form={layOutEntryForm(field, entry)} />
              </div>
            ))
          : field.rows.map((row) => (
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
      <span className="text-sm text-muted-foreground">{t("No file")}</span>
    ) : (
      <AttachmentLink attachment={field.file} />
    );
  }
  if (field.type === "url" && isUrlFieldValue(field.value)) {
    return <ExternalUrl href={field.value}>{field.label}</ExternalUrl>;
  }
  if (field.linkedCollectionId !== undefined && typeof field.value === "string")
    return <RecordLink collectionId={field.linkedCollectionId} recordKey={field.value} />;
  if (field.type === "text" && field.isMarkdown && typeof field.value === "string")
    return <MarkdownText text={field.value} />;
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
  /** Shows a linked record as it was just saved. */
  readonly onRecordSaved?: () => void;
  readonly wrapEntryText?: boolean;
  readonly recordStatus?:
    | ((field: FieldView) => ((record: FieldView["records"][number]) => ReactNode) | undefined)
    | undefined;
};

/** A repeatable group's entries: rows with an id. */
export type Entry = { readonly id: string; readonly fields: ReadonlyArray<FieldView> };

/** An entry's field of the group's row field `fieldId`, if the entry shows it. */
export const findEntryField = (group: FieldView, entry: Entry, fieldId: string) =>
  entry.fields.find((view) => view.key === `${group.key}.${entry.id}.${fieldId}`);

/** A repeatable group's entries in the order its layout sorts them; they stay kept as added. */
export const sortEntries = (field: FieldView): ReadonlyArray<Entry> =>
  sortRows(
    field.rows.flatMap((row) => (row.id === null ? [] : [{ id: row.id, fields: row.fields }])),
    resolveTableLayout(field.rowFields, field.layout).sortBy,
    (entry, fieldId) => findEntryField(field, entry, fieldId)?.value,
  );

/** How many ch each of a group's table `columns` wants, from what its entries show in it. */
export const measureColumnWidths = (
  group: FieldView,
  columns: ReadonlyArray<TableColumn>,
  entries: ReadonlyArray<Entry>,
) =>
  columns.map((column) =>
    measureColumnWidth(
      column,
      entries.flatMap((entry) => {
        const view = findEntryField(group, entry, column.field.id);
        return view === undefined || view.value === null ? [] : [shownValue(view)];
      }),
    ),
  );

/**
 * A form's `views` as `layout` lays out the fields they show, each with the span it takes; a
 * view's key is `prefix` and its field's id.
 */
export const layOutForm = (
  fields: ReadonlyArray<Field>,
  layout: Layout | undefined,
  views: ReadonlyArray<FieldView>,
  prefix: string,
) => {
  const form = resolveFormLayout(fields, layout);
  return {
    ...form,
    fields: form.fields.flatMap(({ field, span }) =>
      views.filter((view) => view.key === `${prefix}${field.id}`).map((view) => ({ view, span })),
    ),
  };
};

/** A number field's unit beside its input, so what's typed stays a plain number. */
function UnitSuffix({
  field,
  className,
}: {
  readonly field: FieldView;
  readonly className?: string;
}) {
  return field.unit === undefined ? null : (
    <span className={cn("shrink-0 text-muted-foreground", className)}>{field.unit}</span>
  );
}

/**
 * The field's stored value as an input holds it: a date input takes the day alone, a number its
 * decimals but not its unit. Leaving the input unchanged saves nothing, so a shown rounding never
 * replaces the value.
 */
const storedText = (field: FieldView) =>
  field.value === null
    ? ""
    : field.type === "date"
      ? String(field.value).slice(0, 10)
      : field.type === "number" && typeof field.value === "number"
        ? // A number input takes a decimal point; the browser shows it in the viewer's language.
          field.decimals === undefined
          ? String(field.value)
          : field.value.toFixed(field.decimals)
        : String(field.value);

/** What the field saves from what was typed into it: nothing, a number, or the text. */
const typedValue = (field: FieldView, typed: string): StepFieldValue =>
  typed === "" ? null : field.type === "number" ? Number(typed) : typed;

/** A link field's record, picked from its collection; another is picked once it is unlinked. */
function RecordLinkInput({
  field,
  control,
  onSave,
}: {
  readonly field: FieldView;
  readonly control: ComponentProps<typeof Button>;
  readonly onSave: (value: StepFieldValue) => void;
}) {
  const t = useTranslation();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const collectionId = field.linkedCollectionId;
  if (collectionId === undefined) return null;
  const pick = () =>
    void api("collections.get", { collectionId }).then(setCollection, (cause: unknown) =>
      setError(describeFailure(cause)),
    );
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2 sm:min-h-8">
      {typeof field.value === "string" ? (
        <>
          <RecordLink collectionId={collectionId} recordKey={field.value} />
          <Button
            {...control}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("Unlink record {0}", field.value)}
            onClick={() => onSave(null)}
          >
            <XIcon />
          </Button>
        </>
      ) : (
        <Button {...control} type="button" size="xs" variant="outline" onClick={pick}>
          {t("Link a record")}
        </Button>
      )}
      {error && <ErrorText text={error} />}
      {collection === null ? null : (
        <RecordPicker
          label={field.label}
          collection={collection}
          linked={[]}
          onClose={() => setCollection(null)}
          onPick={(record) => {
            setCollection(null);
            onSave(record.key);
          }}
        />
      )}
    </div>
  );
}

/** A field's input, framed; a group has none. */
function FieldControl({
  field,
  control,
  isStacked,
  onSave,
  onUpload,
}: Omit<EditorProps, "missing"> & {
  readonly isStacked: boolean;
  readonly control: {
    readonly id: string;
    readonly "aria-describedby": string | undefined;
    readonly "aria-invalid": true | undefined;
  };
}) {
  const t = useTranslation();
  const save = (value: StepFieldValue) => onSave(field.key, value);
  const saveText = (typed: string) => save(typedValue(field, typed));
  switch (field.type) {
    case "url":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <SavedInput
            {...control}
            type="url"
            placeholder="https://example.com"
            value={storedText(field)}
            onSave={saveText}
          />
          {isUrlFieldValue(field.value) ? (
            <ExternalUrl href={field.value}>{field.label}</ExternalUrl>
          ) : null}
        </div>
      );
    case "text":
      if (field.isMarkdown)
        return (
          <MarkdownInput
            {...control}
            label={field.label}
            value={storedText(field)}
            onSave={saveText}
          />
        );
      // One line tall at first, growing with what's written; in an entry's form, to show all of it.
      return (
        <SavedInput
          {...control}
          multiline
          className={cn(
            "[&_textarea]:min-h-0 [&_textarea]:resize-none",
            isStacked && "[&_textarea]:max-h-none",
          )}
          value={storedText(field)}
          onSave={saveText}
        />
      );
    case "number":
      return (
        <div className="flex items-center gap-1.5 text-sm">
          <SavedInput
            {...control}
            type="number"
            className="flex-1"
            value={storedText(field)}
            onSave={saveText}
          />
          <UnitSuffix field={field} />
        </div>
      );
    case "date":
      return (
        <SavedInput {...control} type={field.type} value={storedText(field)} onSave={saveText} />
      );
    case "select":
      if (field.isMultiple)
        return (
          <Select
            multiple
            value={Array.isArray(field.value) ? field.value : []}
            onValueChange={(options: Array<string>) => save(options)}
          >
            <SelectTrigger {...control} isWrapped={isStacked}>
              <SelectValue placeholder={t("Choose some")}>
                {(options: Array<string>) => options.join(", ")}
              </SelectValue>
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
      return (
        <Select value={typeof field.value === "string" ? field.value : null} onValueChange={save}>
          <SelectTrigger {...control} isWrapped={isStacked}>
            <SelectValue placeholder={t("Choose one")} />
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
            <span className="text-sm text-muted-foreground">{t("No file")}</span>
          ) : (
            <AttachmentLink attachment={field.file} />
          )}
          <FilePickButton
            {...control}
            label={field.file === null ? t("Upload") : t("Replace")}
            onPick={(file) => onUpload(field.key, file)}
          />
        </div>
      );
    case "foreignKey":
      return <RecordLinkInput field={field} control={control} onSave={save} />;
    case "records":
    case "group":
      return null;
  }
}

/**
 * A field with its label: beside the input, wrapping above it when narrow, or with a form's `span`
 * always above it, where the guidance goes under the input so inputs side by side line up. A
 * group shows its own way.
 */
function FieldEditor({
  span,
  ...props
}: EditorProps & {
  readonly span?: keyof typeof FORM_SPANS;
}) {
  const t = useTranslation();
  const { field, missing } = props;
  const isStacked = span !== undefined;
  const id = useId();
  if (field.type === "records") return <LinkedRecords {...props} />;
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
        isStacked
          ? cn("flex min-w-0 flex-col gap-1", FORM_SPANS[span])
          : "flex flex-wrap items-start gap-x-4 gap-y-1"
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
          isStacked={isStacked}
          control={{ id, "aria-describedby": describedBy, "aria-invalid": invalid }}
        />
        {field.linkUrl === undefined ? null : (
          <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>
        )}
        {isStacked && guidance}
        {invalid && <ErrorText id={`${id}-missing`} text={t("Required")} />}
      </div>
    </div>
  );
}

const isSetApart = (field: FieldView | undefined) =>
  field?.type === "group" || field?.type === "records";

/** Fields in order: one after another close together, and each group or record list set apart. */
function FieldInputs({
  fields,
  ...props
}: Omit<EditorProps, "field"> & { readonly fields: ReadonlyArray<FieldView> }) {
  const runs: Array<Array<FieldView>> = [];
  for (const field of fields) {
    const run = runs.at(-1);
    if (!isSetApart(field) && !isSetApart(run?.[0]) && run !== undefined) run.push(field);
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

/** An entry's form, as its group's layout lays it out. */
export const layOutEntryForm = (group: FieldView, entry: Entry) =>
  layOutForm(group.rowFields, group.layout, entry.fields, `${group.key}.${entry.id}.`);

/** A form's fields as `layOutForm` lays them out, labels above. */
export function FormGrid({
  form,
  className,
  ...props
}: Omit<EditorProps, "field"> & {
  readonly form: ReturnType<typeof layOutForm>;
  readonly className?: string;
}) {
  return (
    <div className={cn(FORM_GRIDS[form.spacing], className)}>
      {form.fields.map(({ view, span }) => (
        <FieldEditor key={view.key} {...props} field={view} span={span} />
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
        <h3 className="text-sm/6 font-medium">
          {field.linkUrl === undefined ? (
            field.label
          ) : (
            <ExternalUrl href={field.linkUrl}>{field.label}</ExternalUrl>
          )}
        </h3>
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
        <FieldInputs {...props} fields={field.rows.flatMap((row) => row.fields)} />
      </div>
    </div>
  );
}

/**
 * A records field: the collection's records it links, listed as the collection lists them. A
 * record opens to edit it; others are linked from the collection, or added to it and linked.
 */
function LinkedRecords({ field, missing, onSave, onRecordSaved, recordStatus }: EditorProps) {
  const t = useTranslation();
  const [opened, setOpened] = useState<{
    readonly values: FieldValues;
    readonly files: FieldView["records"][number]["files"];
  } | null>(null);
  const [viewedKey, setViewedKey] = useState<string | null>(null);
  const showcasePopup = useRef<HTMLDivElement>(null);
  const [isPicking, setIsPicking] = useState(false);
  const { collection } = field;
  const hasShowcase = collection?.layout?.page?.template === "showcase";
  const viewed = field.records.find((record) => record.key === viewedKey);
  const renderStatus = recordStatus?.(field);
  const canPickRecord = renderStatus === undefined;
  const keys = recordKeys(field.value);
  const link = (key: string) => onSave(field.key, [...keys, key]);
  return (
    <div data-field-key={field.key} className="col-span-full flex flex-col gap-2">
      <GroupHeading field={field}>
        <span className="text-xs text-muted-foreground">
          {t(field.records.length === 1 ? "{0} record" : "{0} records", field.records.length)}
        </span>
      </GroupHeading>
      {missing.has(field.key) && (
        <ErrorText
          text={canPickRecord ? t("Link at least one record") : t("Add at least one record")}
        />
      )}
      {collection === null ? (
        <p className="text-sm text-muted-foreground">{t("Its collection is gone.")}</p>
      ) : (
        <>
          {field.records.length > 0 ? (
            <RecordTable
              label={field.label}
              collection={collection}
              records={field.records}
              onOpen={hasShowcase ? undefined : setOpened}
              onView={hasShowcase ? (record) => setViewedKey(record.key) : undefined}
              onEdit={setOpened}
              renderStatus={renderStatus}
              remove={(record) => ({
                label: t("Unlink record {0}", record.key),
                onRemove: () =>
                  onSave(
                    field.key,
                    keys.filter((key) => key !== record.key),
                  ),
              })}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canPickRecord ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setIsPicking(true)}>
                <LinkIcon />
                {t("Link record")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpened({ values: defaultValues(collection.fields), files: [] })}
            >
              <PlusIcon />
              {t("New record")}
            </Button>
          </div>
          {viewed === undefined ? null : (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setViewedKey(null);
              }}
            >
              <DialogPopup
                ref={showcasePopup}
                initialFocus={showcasePopup}
                className="sm:max-w-5xl"
              >
                <DialogHeader>
                  <DialogTitle>{t("Record details")}</DialogTitle>
                </DialogHeader>
                <DialogPanel>
                  <RecordShowcase collection={collection} record={viewed} />
                </DialogPanel>
                <DialogFooter>
                  <Button
                    type="button"
                    onClick={() => {
                      setViewedKey(null);
                      setOpened(viewed);
                    }}
                  >
                    {t("Edit record")}
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          )}
          {opened === null ? null : (
            <RecordDialog
              collection={collection}
              record={opened}
              onClose={() => setOpened(null)}
              onSaved={(record) => {
                setOpened(null);
                if (keys.includes(record.key)) onRecordSaved?.();
                else link(record.key);
              }}
            />
          )}
          {canPickRecord && isPicking ? (
            <RecordPicker
              label={field.label}
              collection={collection}
              linked={keys}
              onClose={() => setIsPicking(false)}
              onPick={(record) => {
                setIsPicking(false);
                link(record.key);
              }}
            />
          ) : null}
        </>
      )}
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
  const t = useTranslation();
  const { field, missing, onSave } = props;
  const isTable = field.rowFields.every((child) => child.type !== "group");
  const [shown, setShown] = useState(isTable ? "table" : "form");
  const entries = sortEntries(field);
  const ids = field.rows.flatMap((row) => (row.id === null ? [] : [row.id]));
  const remove = (at: number) => ({
    label: t("Remove entry {0} of {1}", at + 1, field.label),
    onRemove: () =>
      onSave(
        field.key,
        ids.filter((id) => id !== entries[at]?.id),
      ),
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
            {entries.length === 1 ? t("1 entry") : t("{0} entries", entries.length)}
          </span>
          {isTable ? (
            <TabsList size="sm" aria-label={t("Show {0} as", field.label)} className="ml-auto">
              <TabsTab size="sm" value="table">
                {t("Table")}
              </TabsTab>
              <TabsTab size="sm" value="form">
                {t("Form")}
              </TabsTab>
            </TabsList>
          ) : null}
        </GroupHeading>
        {missing.has(field.key) && <ErrorText text={t("Add at least one entry")} />}
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
            {t("Add entry")}
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
  "border-l border-border/60 bg-muted px-1.5 first:border-l-0 py-2 text-left align-top text-xs font-medium text-foreground/80";

/**
 * The entries as rows of a table, a column per field its layout shows in the table, typed into in
 * place; when some fields show only in details, each entry opens to all its fields.
 */
function EntryTable({ entries, remove, ...props }: EntriesProps) {
  const t = useTranslation();
  const { field, missing, onSave, onUpload } = props;
  const { columns, density } = resolveTableLayout(field.rowFields, field.layout);
  const isColumn = (child: FieldView, entry: Entry) =>
    columns.some((column) => child.key === `${field.key}.${entry.id}.${column.field.id}`);
  const hasDetails = field.rowFields.some(
    (child) => !columns.some((column) => column.field.id === child.id),
  );
  // By id, as editing a sort field in the details moves its entry.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsAt = entries.findIndex((entry) => entry.id === detailsId);
  const opened = entries[detailsAt];
  const form = opened === undefined ? null : layOutEntryForm(field, opened);
  // Columns share the table by the width they want, which it never squeezes: it scrolls instead.
  const widths = measureColumnWidths(field, columns, entries);
  const total = widths.reduce((sum, width) => sum + width, 0);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table
        className={cn(
          "w-full table-fixed border-separate border-spacing-0 text-sm",
          CONTROL_CELL_DENSITY[density],
        )}
        style={{ minWidth: `calc(${total}ch + ${hasDetails ? 6.5 : 2}rem)` }}
      >
        <colgroup>
          {columns.map((column, at) => (
            <col key={column.field.id} style={{ width: `${(100 * widths[at]!) / total}%` }} />
          ))}
          {hasDetails ? <col className="w-18" /> : null}
          <col className="w-8" />
        </colgroup>
        <thead>
          <tr>
            {columns.map(({ field: child, header }) => (
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
                      {header}
                    </TooltipTrigger>
                    <TooltipPopup>{child.description}</TooltipPopup>
                  </Tooltip>
                ) : (
                  header
                )}
              </th>
            ))}
            {hasDetails ? (
              <th scope="col" className={headerCell}>
                <span className="sr-only">{t("Details")}</span>
              </th>
            ) : null}
            <th scope="col" className={headerCell}>
              <span className="sr-only">{t("Remove")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, at) => (
            <tr key={entry.id}>
              {columns.map((column) => {
                const child = findEntryField(field, entry, column.field.id);
                return (
                  <td
                    key={column.field.id}
                    data-field-key={child?.key}
                    className="border-t border-l border-l-border/60 p-0 align-top first:border-l-0 has-aria-invalid:bg-destructive/8"
                  >
                    {child === undefined ? null : (
                      <CellControl
                        field={child}
                        label={t("{0}, entry {1}", child.label, at + 1)}
                        isWrapped={
                          column.isWrapped ||
                          (props.wrapEntryText === true &&
                            (child.type === "text" || child.type === "url"))
                        }
                        isMissing={missing.has(child.key)}
                        onSave={onSave}
                        onUpload={onUpload}
                      />
                    )}
                  </td>
                );
              })}
              {hasDetails ? (
                <td className="border-t border-l border-l-border/60 text-center">
                  {/* Each field shown only in details leads to this button, as a missing field's link does. */}
                  {entry.fields
                    .filter((child) => !isColumn(child, entry))
                    .reduceRight(
                      (button, child) => (
                        <span data-field-key={child.key}>{button}</span>
                      ),
                      <Button
                        type="button"
                        size="xs"
                        variant={
                          entry.fields.some(
                            (child) => !isColumn(child, entry) && missing.has(child.key),
                          )
                            ? "destructive-outline"
                            : "ghost"
                        }
                        aria-label={t("Details of entry {0} of {1}", at + 1, field.label)}
                        onClick={() => setDetailsId(entry.id)}
                      >
                        {t("Details")}
                      </Button>,
                    )}
                </td>
              ) : null}
              <td className="border-t border-l border-l-border/60 text-center">
                <RemoveEntry {...remove(at)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {form === null ? null : (
        <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : setDetailsId(null))}>
          <DialogPopup
            className={
              form.dialogWidth === 768
                ? "sm:max-w-3xl"
                : form.dialogWidth === 1280
                  ? "sm:max-w-7xl"
                  : "sm:max-w-5xl"
            }
          >
            <DialogHeader>
              <DialogTitle>{t("{0}, entry {1}", field.label, detailsAt + 1)}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <FormGrid {...props} form={form} />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}

const cellInput =
  "w-full bg-transparent px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** A field's input as a table cell holds it: unframed, named by `label`, `isWrapped` as its column. */
function CellControl({
  field,
  label,
  isWrapped,
  isMissing,
  onSave,
  onUpload,
}: Omit<EditorProps, "missing"> & {
  readonly label: string;
  readonly isWrapped: boolean;
  readonly isMissing: boolean;
}) {
  const t = useTranslation();
  if (field.linkUrl !== undefined) {
    const link = <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>;
    return isWrapped ? (
      <div className="min-h-9 px-1.5 py-2 wrap-break-word">{link}</div>
    ) : (
      <OneLineValue value={shownValue(field)} className="min-h-9 px-1.5 py-2">
        {link}
      </OneLineValue>
    );
  }
  const control = { "aria-label": label, "aria-invalid": isMissing || undefined };
  const stored = storedText(field);
  if (field.type === "text" && field.isMarkdown)
    return (
      <MarkdownInput
        aria-invalid={isMissing || undefined}
        label={label}
        value={stored}
        onSave={(typed) => onSave(field.key, typedValue(field, typed))}
        isClamped={!isWrapped}
        className="min-h-9 rounded-none border-0"
      />
    );
  const save = saveTyped(stored, (typed) => onSave(field.key, typedValue(field, typed)));
  switch (field.type) {
    case "text":
    case "url": {
      // Unless wrapped, one line until focused, then all of it, so long text stays editable.
      const input = (
        <textarea
          key={stored}
          {...control}
          rows={1}
          defaultValue={stored}
          onBlur={save}
          inputMode={field.type === "url" ? "url" : undefined}
          onKeyDown={(event) => {
            // A web address is one line: Enter saves it, as in the other one-line cells.
            if (field.type === "url" && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className={cn(
            cellInput,
            "block min-h-9 resize-none py-2",
            isWrapped
              ? "field-sizing-content"
              : "truncate focus:field-sizing-content focus:whitespace-pre-wrap",
          )}
        />
      );
      return (
        <>
          {isWrapped || stored === "" ? input : <OneLineValue value={stored}>{input}</OneLineValue>}
          {field.type === "url" && isUrlFieldValue(field.value) ? (
            <div className="px-1.5 pb-1.5">
              <ExternalUrl href={field.value}>{field.label}</ExternalUrl>
            </div>
          ) : null}
        </>
      );
    }
    case "number": {
      // The unit stands beside a value only, so an empty cell stays empty.
      const hasUnit = field.unit !== undefined && field.value !== null;
      return (
        <div className={cn("flex items-center", hasUnit && "pr-1.5")}>
          <input
            key={stored}
            {...control}
            type="number"
            defaultValue={stored}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className={cn(
              cellInput,
              "h-9 min-w-0 [appearance:textfield] text-right [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
              hasUnit && "pr-0",
            )}
          />
          {hasUnit ? (
            <UnitSuffix field={field} className={cn(field.unit !== "%" && "pl-1")} />
          ) : null}
        </div>
      );
    }
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
          className={cn(cellInput, "h-9")}
        />
      );
    case "select": {
      const select = (
        <Select
          value={typeof field.value === "string" ? field.value : null}
          onValueChange={(value) => onSave(field.key, value)}
        >
          <SelectTrigger {...control} variant="cell" isWrapped={isWrapped}>
            <SelectValue>
              {(value: string | null) =>
                value === null ? (
                  t("Choose one")
                ) : (
                  <OptionValue option={value} tones={field.tones} />
                )
              }
            </SelectValue>
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
      // A choice cut to one line shows whole in its tooltip; a tone icon names itself.
      return isWrapped ||
        typeof field.value !== "string" ||
        field.tones?.[field.value] !== undefined ? (
        select
      ) : (
        <OneLineValue value={field.value}>{select}</OneLineValue>
      );
    }
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
            label={field.file === null ? t("Upload") : t("Replace")}
            onPick={(file) => onUpload(field.key, file)}
          />
        </div>
      );
    case "foreignKey":
    case "records":
    case "group":
      return null;
  }
}

/**
 * The entries as a form each, one open at a time; an entry with a field flagged as empty stays
 * open. An entry's header shows its first field's value and how many of its fields are filled.
 */
function EntryForms({ entries, remove, ...props }: EntriesProps) {
  const t = useTranslation();
  const { field } = props;
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
                  {title ?? t("Untitled entry")}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {filled.length} {t("of")} {entry.fields.length} {t("filled")}
                </span>
              </CollapsibleTrigger>
              <RemoveEntry {...remove(at)} />
            </div>
            <CollapsiblePanel>
              <FormGrid {...props} form={layOutEntryForm(field, entry)} className="border-t p-3" />
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
  onRecordSaved,
  recordStatus,
  holdOpen = false,
  review,
}: {
  readonly fields: ReadonlyArray<FieldView>;
  readonly editable: boolean;
  /** Shown first: the review of the values proposed for the fields. */
  readonly review?: ReactNode;
  /** Paths of the fields to flag as still empty. */
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: StepFieldValue) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
  readonly onRecordSaved: () => void;
  readonly recordStatus?: EditorProps["recordStatus"];
  readonly holdOpen?: boolean;
}) {
  const t = useTranslation();
  if (fields.length === 0) return null;
  return (
    <CardFold title={t("Fields")} held={holdOpen || missing.size > 0}>
      {review}
      {editable ? (
        <FieldInputs
          fields={fields}
          missing={missing}
          onSave={onSave}
          onUpload={onUpload}
          onRecordSaved={onRecordSaved}
          recordStatus={recordStatus}
        />
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
      <span className="text-xs text-muted-foreground">
        {field.linkUrl !== undefined && isSetApart(field) ? (
          <ExternalUrl href={field.linkUrl}>{field.label}</ExternalUrl>
        ) : (
          field.label
        )}
      </span>
      <FieldValue field={field} />
    </div>
  ));
}
