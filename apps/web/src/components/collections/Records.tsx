import type { Collection } from "@t45/contracts/models/Collection";
import {
  isUrlFieldValue,
  type FieldValues,
  rowIds,
  withFieldValue,
} from "@t45/contracts/models/Field";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews, getFieldLink } from "@t45/core/fieldViews";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { api } from "../../rpc/api";
import { Button } from "../ui/button";
import { ExternalUrl } from "../ExternalUrl";
import { isTableColumn } from "../fields/fieldPresentation";
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
import { FieldInputs, uploadFile } from "../work/StepFields";
import { formatDay, plural } from "../work/workLogic";

type RecordFiles = CollectionRecordView["files"];

/** What a collection holds of its records: their fields and which one keys them. */
type RecordShape = Pick<Collection, "fields" | "primaryKeyFieldId">;

/** A record's value as text, so a displayed link never wraps another link. */
function formatCellValue(
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
    case "file":
      return files.find((file) => file.id === value)?.name ?? "";
    default:
      return String(value);
  }
}

/** What a record's cell shows, with a sibling URL when one is displayed on it. */
function renderCell(
  field: Collection["fields"][number],
  value: FieldValues[string] | undefined,
  files: RecordFiles,
  linkUrl: string | undefined,
) {
  if (linkUrl !== undefined)
    return (
      <ExternalUrl href={linkUrl} onClick={(event) => event.stopPropagation()}>
        {formatCellValue(field, value, files) || field.label}
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
        formatCellValue(field, value, files)
      );
    default:
      return formatCellValue(field, value, files);
  }
}

const headerCell =
  "bg-muted px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-foreground/80";

/**
 * Records as a table: a column per field shown in the table, the primary key always. With `onOpen`
 * a row opens the record, and with `remove` each row has a way to take it off the list.
 */
export function RecordTable({
  label,
  collection,
  records,
  onOpen,
  remove,
}: {
  readonly label: string;
  readonly collection: RecordShape;
  readonly records: ReadonlyArray<CollectionRecordView>;
  readonly onOpen?: (record: CollectionRecordView) => void;
  readonly remove?: (record: CollectionRecordView) => {
    readonly label: string;
    readonly onRemove: () => void;
  };
}) {
  const columns = collection.fields.filter(
    (field) =>
      field.id === collection.primaryKeyFieldId ||
      (isTableColumn(field) &&
        (field.type !== "group" ||
          field.repeatable ||
          collection.fields.some(
            (source) => source.type === "url" && source.displayLinkOn === field.id,
          ))),
  );
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {columns.map((field) => (
              <th key={field.id} scope="col" className={headerCell}>
                {field.label}
              </th>
            ))}
            <th scope="col" className={headerCell}>
              Last update
            </th>
            {remove === undefined ? null : (
              <th scope="col" className={headerCell}>
                <span className="sr-only">Remove</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
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
                onClick={() => onOpen?.(record)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget)
                    onOpen?.(record);
                }}
              >
                {columns.map((field) => (
                  <td key={field.id} className="max-w-64 truncate border-t px-3 py-2">
                    {renderCell(
                      field,
                      record.values[field.id],
                      record.files,
                      getFieldLink(field.id, collection.fields, record.values),
                    )}
                  </td>
                ))}
                <td className="border-t px-3 py-2 whitespace-nowrap">
                  {formatRelativeTimeLabel(record.updatedAt)}
                </td>
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

/** A record's fields, typed into and saved whole: a record with the same key is replaced. */
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
  const [values, setValues] = useState(record.values);
  const [files, setFiles] = useState(record.files);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, value: FieldValues[string]) =>
    setValues((current) => withFieldValue(collection.fields, current, key, value));
  const fields = buildFieldViews(
    collection.fields,
    values,
    (id) => files.find((file) => file.id === id) ?? null,
  );
  const save = () => {
    setBusy(true);
    setError(null);
    void api("collections.saveRecord", { collectionId: collection.id, values }).then(
      onSaved,
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };
  return (
    <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <DialogPopup aria-label="Record" className="sm:max-w-3xl">
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
              <FieldInputs
                fields={fields}
                missing={new Set()}
                onSave={set}
                onUpload={(key, file) =>
                  void uploadFile(file).then(
                    (id) => {
                      setFiles((current) => [...current, { id, name: file.name }]);
                      set(key, id);
                    },
                    (cause: unknown) => setError(describeFailure(cause)),
                  )
                }
              />
              {error && <ErrorText text={error} />}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
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
