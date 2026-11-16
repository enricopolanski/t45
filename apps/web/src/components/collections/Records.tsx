import { type Collection, UPDATED_AT_COLUMN } from "@t45/contracts/models/Collection";
import {
  isUrlFieldValue,
  type FieldValues,
  rowIds,
  withFieldValue,
} from "@t45/contracts/models/Field";
import { isTableColumn, resolveTableLayout, sortRows } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews, getFieldLink } from "@t45/core/fieldViews";
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { api } from "../../rpc/api";
import { Button } from "../ui/button";
import { ExternalUrl } from "../ExternalUrl";
import { FIXED_WIDTHS } from "../fields/fieldPresentation";
import { OneLineValue } from "../fields/OneLineValue";
import { MarkdownText } from "../markdown/MarkdownText";
import { OptionValue } from "../fields/OptionValue";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { FormGrid, layOutForm, uploadFile } from "../work/StepFields";
import { formatDay, formatNumber, plural } from "../work/workLogic";

type RecordFiles = CollectionRecordView["files"];

/** What a collection holds of its records: their fields and which one keys them. */
type RecordShape = Pick<Collection, "fields" | "primaryKeyFieldId" | "columnOrder" | "layout">;

/** A record's value as text, so a displayed link never wraps another link. */
export function formatRecordValue(
  field: Collection["fields"][number],
  value: FieldValues[string] | undefined,
  files: RecordFiles,
) {
  if (field.type === "group")
    return field.repeatable ? plural(rowIds(value).length, "entry", "entries") : field.label;
  if (value === undefined) return "";
  switch (field.type) {
    case "boolean":
      return value === true ? "Yes" : "No";
    case "date":
      return formatDay(String(value));
    case "number":
      return typeof value === "number" ? formatNumber(value, field) : String(value);
    case "file":
      return files.find((file) => file.id === value)?.name ?? "";
    default:
      return String(value);
  }
}

/** What a record's cell shows, with a sibling URL when one is displayed on it. */
export function renderRecordValue(
  field: Collection["fields"][number],
  value: FieldValues[string] | undefined,
  files: RecordFiles,
  linkUrl: string | undefined,
  isWrapped: boolean,
) {
  if (linkUrl !== undefined)
    return (
      <ExternalUrl href={linkUrl} onClick={(event) => event.stopPropagation()}>
        {formatRecordValue(field, value, files) || field.label}
      </ExternalUrl>
    );
  switch (field.type) {
    case "url":
      return isUrlFieldValue(value) ? (
        <ExternalUrl href={value} onClick={(event) => event.stopPropagation()}>
          {field.label}
        </ExternalUrl>
      ) : (
        ""
      );
    case "text":
      if (field.isMarkdown && typeof value === "string")
        return <MarkdownText text={value} isClamped={!isWrapped} />;
      // A web address shows as a link, so long URLs don't crowd the table.
      return typeof value === "string" && /^https?:\/\/\S+$/u.test(value.trim()) ? (
        <a
          href={value.trim()}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline"
          onClick={(event) => event.stopPropagation()}
        >
          Link
        </a>
      ) : (
        formatRecordValue(field, value, files)
      );
    case "select":
      return typeof value === "string" ? <OptionValue option={value} tones={field.tones} /> : "";
    default:
      return formatRecordValue(field, value, files);
  }
}

/**
 * The value as text that can run long, which a cell wraps or cuts as its field says: text, a web
 * address, or a choice without a tone icon.
 */
const findLongText = (
  field: Collection["fields"][number],
  value: FieldValues[string] | undefined,
) =>
  typeof value === "string" &&
  (field.type === "text" ||
    field.type === "url" ||
    (field.type === "select" && field.tones?.[value] === undefined))
    ? value
    : undefined;

/** Every column of the records table in the column order, the last update included. */
const listColumnOrder = (collection: RecordShape) => [
  ...new Set([
    ...(collection.columnOrder ?? []),
    ...collection.fields.map((field) => field.id),
    UPDATED_AT_COLUMN,
  ]),
];

/**
 * The fields the records table lists when its layout lists none, in the column order: the primary
 * key always, and each field shown in the table but a group that neither repeats nor shows a link.
 */
export const listDefaultColumns = (collection: RecordShape) =>
  listColumnOrder(collection).flatMap((id) =>
    collection.fields.filter(
      (field) =>
        field.id === id &&
        (field.id === collection.primaryKeyFieldId ||
          (isTableColumn(field) &&
            (field.type !== "group" ||
              field.repeatable ||
              collection.fields.some(
                (source) => source.type === "url" && source.displayLinkOn === field.id,
              )))),
    ),
  );

const headerCell =
  "bg-muted px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-foreground/80";

/** A fixed width holds a column however long its values; without one the table fits them. */
const makeFixedWidthStyle = (width: keyof typeof FIXED_WIDTHS | undefined) => {
  if (width === undefined) return undefined;
  const fixed = `${FIXED_WIDTHS[width]}ch`;
  return { width: fixed, minWidth: fixed, maxWidth: fixed };
};

/** A table's density for cells padded around their values. */
const CELL_DENSITY = { compact: "[&_td]:py-1", normal: "", relaxed: "[&_td]:py-3" };

/**
 * Records as a table, in the order the collection's layout sorts them: a column per field its
 * layout lists, then the last update; without that list, a column per field shown in the table,
 * the primary key always, in the column order. With `onOpen` a row opens the record, and with
 * `remove` each row has a way to take it off the list, and with `reorder` columns move in the
 * column order.
 */
export function RecordTable({
  label,
  collection,
  records,
  onOpen,
  remove,
  reorder,
}: {
  readonly label: string;
  readonly collection: RecordShape;
  readonly records: ReadonlyArray<CollectionRecordView>;
  readonly onOpen?: (record: CollectionRecordView) => void;
  readonly remove?: (record: CollectionRecordView) => {
    readonly label: string;
    readonly onRemove: () => void;
  };
  readonly reorder?:
    | {
        readonly disabled: boolean;
        readonly onChange: (columnOrder: ReadonlyArray<string>) => void;
      }
    | undefined;
}) {
  const order = listColumnOrder(collection);
  const table = resolveTableLayout(
    collection.fields,
    collection.layout,
    listDefaultColumns(collection),
  );
  const hasLayoutColumns = collection.layout?.table?.columns !== undefined;
  const shown = [
    ...table.columns.map((column) => ({ id: column.field.id, label: column.header, column })),
    { id: UPDATED_AT_COLUMN, label: "Last update", column: null },
  ];
  const columns = hasLayoutColumns
    ? shown
    : order.flatMap((id) => shown.filter((column) => column.id === id));
  const sorted = sortRows(records, table.sortBy, (record, fieldId) => record.values[fieldId]);
  const move = (from: string, to: string) => {
    const next = [...order];
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(to);
    next[fromIndex] = to;
    next[toIndex] = from;
    reorder?.onChange(next);
  };
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table
        aria-label={label}
        className={cn(
          "w-full border-separate border-spacing-0 text-sm",
          CELL_DENSITY[table.density],
        )}
      >
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column.id}
                scope="col"
                // A fixed width holds a long header too, wrapping it.
                style={makeFixedWidthStyle(column.column?.width)}
                className={cn(
                  headerCell,
                  column.column?.width !== undefined && "whitespace-normal",
                )}
              >
                {reorder === undefined ? null : (
                  <div className="-ml-1 mb-1 flex gap-0.5">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${column.label} left`}
                      disabled={reorder.disabled || index === 0}
                      onClick={() => move(column.id, columns[index - 1]!.id)}
                    >
                      <ArrowLeftIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${column.label} right`}
                      disabled={reorder.disabled || index === columns.length - 1}
                      onClick={() => move(column.id, columns[index + 1]!.id)}
                    >
                      <ArrowRightIcon />
                    </Button>
                  </div>
                )}
                {column.label}
              </th>
            ))}
            {remove === undefined ? null : (
              <th scope="col" className={headerCell}>
                <span className="sr-only">Remove</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((record) => {
            const removal = remove?.(record);
            return (
              <tr
                key={record.key}
                tabIndex={onOpen === undefined ? undefined : 0}
                aria-label={`Record ${record.key}`}
                className={
                  onOpen === undefined
                    ? undefined
                    : "cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                }
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("a, button")) return;
                  onOpen?.(record);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget)
                    onOpen?.(record);
                }}
              >
                {columns.map(({ id, column }) => {
                  if (column === null)
                    return (
                      <td key={id} className="max-w-64 truncate border-t px-3 py-2">
                        {formatRelativeTimeLabel(record.updatedAt)}
                      </td>
                    );
                  const { field } = column;
                  const value = record.values[field.id];
                  const cell = renderRecordValue(
                    field,
                    value,
                    record.files,
                    getFieldLink(field.id, collection.fields, record.values),
                    column.isWrapped,
                  );
                  const text = findLongText(field, value);
                  const isWrapped = text !== undefined && column.isWrapped;
                  return (
                    <td
                      key={id}
                      style={makeFixedWidthStyle(column.width)}
                      className={cn(
                        "max-w-64 border-t px-3 py-2",
                        isWrapped ? "wrap-break-word" : "truncate",
                      )}
                    >
                      {text === undefined ||
                      isWrapped ||
                      (field.type === "text" && field.isMarkdown) ? (
                        cell
                      ) : (
                        <OneLineValue value={text}>{cell}</OneLineValue>
                      )}
                    </td>
                  );
                })}
                {removal === undefined ? null : (
                  <td className="w-8 border-t text-center">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={removal.label}
                      onClick={(event) => {
                        event.stopPropagation();
                        removal.onRemove();
                      }}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A record's fields being typed into, laid out as the collection's form, and saved whole: a record
 * with the same key is replaced.
 */
export function useRecordForm(
  collection: RecordShape & Pick<Collection, "id">,
  record: { readonly values: FieldValues; readonly files: RecordFiles },
  onSaved: (record: CollectionRecordView) => void,
) {
  const [values, setValues] = useState(record.values);
  const [files, setFiles] = useState(record.files);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, value: FieldValues[string]) =>
    setValues((current) => withFieldValue(collection.fields, current, key, value));
  const fields = buildFieldViews(
    collection.fields,
    values,
    (id) => files.find((file) => file.id === id) ?? null,
  );
  const editor = {
    missing: new Set<string>(),
    onSave: set,
    onUpload: (key: string, file: File) =>
      void uploadFile(file).then(
        (id) => {
          setFiles((current) => [...current, { id, name: file.name }]);
          set(key, id);
        },
        (cause: unknown) => setError(describeFailure(cause)),
      ),
  };
  const save = () => {
    setIsBusy(true);
    setError(null);
    void api("collections.saveRecord", { collectionId: collection.id, values }).then(
      onSaved,
      (cause: unknown) => {
        setIsBusy(false);
        setError(describeFailure(cause));
      },
    );
  };
  return {
    editor,
    form: layOutForm(collection.fields, collection.layout, fields, ""),
    isBusy,
    error,
    save,
  };
}

/** A record's fields in a dialog, typed into and saved: a new record, or one a step links. */
export function RecordDialog({
  collection,
  record,
  onClose,
  onSaved,
}: {
  readonly collection: RecordShape & Pick<Collection, "id">;
  readonly record: { readonly values: FieldValues; readonly files: RecordFiles };
  readonly onClose: () => void;
  readonly onSaved: (record: CollectionRecordView) => void;
}) {
  const { editor, form, isBusy, error, save } = useRecordForm(collection, record, onSaved);
  return (
    <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <DialogPopup
        aria-label="Record"
        className={
          form.dialogWidth === 1024
            ? "sm:max-w-5xl"
            : form.dialogWidth === 1280
              ? "sm:max-w-7xl"
              : "sm:max-w-3xl"
        }
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Record</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <FormGrid {...editor} form={form} />
              {error && <ErrorText text={error} />}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="submit" disabled={isBusy}>
              Save record
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The collection's records found by their text, but those `linked` already, one picked to link. */
export function RecordPicker({
  label,
  collection,
  linked,
  onClose,
  onPick,
}: {
  readonly label: string;
  readonly collection: RecordShape & Pick<Collection, "id">;
  readonly linked: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onPick: (record: CollectionRecordView) => void;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<{
    readonly records: ReadonlyArray<CollectionRecordView>;
    readonly hasMore: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useCallback(
    (offset: number) =>
      api("collections.searchRecords", { collectionId: collection.id, text, offset }),
    [collection.id, text],
  );
  useEffect(() => {
    let current = true;
    void search(0).then(
      (loaded) => current && setFound(loaded),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [search]);
  const loadMore = () =>
    void search(found?.records.length ?? 0).then(
      (more) =>
        setFound((shown) => ({
          records: [...(shown?.records ?? []), ...more.records],
          hasMore: more.hasMore,
        })),
      (cause: unknown) => setError(describeFailure(cause)),
    );
  const records = found?.records.filter((record) => !linked.includes(record.key)) ?? [];
  return (
    <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{`Link a record to ${label}`}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              type="search"
              aria-label="Search records"
              placeholder="Search records"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {error && <ErrorText text={error} />}
            {found !== null && records.length === 0 && !found.hasMore ? (
              <p className="text-sm text-muted-foreground">No record to link.</p>
            ) : null}
            {records.length > 0 ? (
              <RecordTable
                label="Records to link"
                collection={collection}
                records={records}
                onOpen={onPick}
              />
            ) : null}
            {found?.hasMore ? (
              <div>
                <Button type="button" size="sm" variant="outline" onClick={loadMore}>
                  Show more
                </Button>
              </div>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
