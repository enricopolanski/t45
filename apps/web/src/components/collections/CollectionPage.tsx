import type { Collection } from "@t45/contracts/models/Collection";
import {
  defaultValues,
  isUrlFieldValue,
  type FieldValues,
  rowIds,
  withFieldValue,
} from "@t45/contracts/models/Field";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews } from "@t45/core/fieldViews";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { api } from "../../rpc/api";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { ExternalUrl } from "../ExternalUrl";
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
import { WorkFrame } from "../work/WorkFrame";
import { formatDay, plural } from "../work/workLogic";

type RecordFiles = CollectionRecordView["files"];

/** What a record's cell shows of a top-level field. */
function cellContent(
  field: Collection["fields"][number],
  value: FieldValues[string] | undefined,
  files: RecordFiles,
) {
  if (value === undefined) return "";
  switch (field.type) {
    case "boolean":
      return value === true ? "Yes" : "No";
    case "date":
      return formatDay(String(value));
    case "file":
      return files.find((file) => file.id === value)?.name ?? "";
    case "group":
      return plural(rowIds(value).length, "entry", "entries");
    case "url":
      return isUrlFieldValue(value) ? (
        <ExternalUrl href={value.url} onClick={(event) => event.stopPropagation()}>
          {value.label}
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
        String(value)
      );
    default:
      return String(value);
  }
}

/** A collection's records: found by their text, opened to edit, and added. */
export function CollectionPage({ collectionId }: { readonly collectionId: string }) {
  const isAdmin = useIsAdmin();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<{
    readonly records: ReadonlyArray<CollectionRecordView>;
    readonly hasMore: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{
    readonly values: FieldValues;
    readonly files: RecordFiles;
  } | null>(null);

  useEffect(() => {
    let current = true;
    void api("collections.get", { collectionId }).then(
      (loaded) => current && setCollection(loaded),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [collectionId]);

  const search = useCallback(
    (offset: number) => api("collections.searchRecords", { collectionId, text, offset }),
    [collectionId, text],
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

  if (collection === null)
    return (
      <WorkFrame title="Collection">
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  const columns = collection.fields.filter((field) => field.type !== "group" || field.repeatable);
  return (
    <WorkFrame
      title={collection.title}
      width="full"
      actions={
        <>
          {isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link to="/settings/collections/$collectionId/edit" params={{ collectionId }} />
              }
            >
              Edit collection
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => setOpen({ values: defaultValues(collection.fields), files: [] })}
          >
            <PlusIcon />
            New record
          </Button>
        </>
      }
    >
      <Input
        type="search"
        aria-label="Search records"
        placeholder="Search records"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <ErrorText text={error} />}
      {found !== null && found.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {text.trim() === "" ? "No records yet." : "No record matches."}
        </p>
      ) : null}
      {found !== null && found.records.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table aria-label="Records" className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {columns.map((field) => (
                  <th
                    key={field.id}
                    scope="col"
                    className="bg-muted px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-foreground/80"
                  >
                    {field.label}
                  </th>
                ))}
                <th
                  scope="col"
                  className="bg-muted px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-foreground/80"
                >
                  Last update
                </th>
              </tr>
            </thead>
            <tbody>
              {found.records.map((record) => (
                <tr
                  key={record.key}
                  tabIndex={0}
                  aria-label={`Record ${record.key}`}
                  className="cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  onClick={() => setOpen({ values: record.values, files: record.files })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.target === event.currentTarget)
                      setOpen({ values: record.values, files: record.files });
                  }}
                >
                  {columns.map((field) => (
                    <td key={field.id} className="max-w-64 truncate border-t px-3 py-2">
                      {cellContent(field, record.values[field.id], record.files)}
                    </td>
                  ))}
                  <td className="border-t px-3 py-2 whitespace-nowrap">
                    {formatRelativeTimeLabel(record.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {found?.hasMore ? (
        <div>
          <Button size="sm" variant="outline" onClick={loadMore}>
            Show more
          </Button>
        </div>
      ) : null}
      {open === null ? null : (
        <RecordDialog
          collection={collection}
          record={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void search(0).then(setFound, (cause: unknown) => setError(describeFailure(cause)));
          }}
        />
      )}
    </WorkFrame>
  );
}

/** A record's fields, typed into and saved whole: a record with the same key is replaced. */
function RecordDialog({
  collection,
  record,
  onClose,
  onSaved,
}: {
  readonly collection: Collection;
  readonly record: { readonly values: FieldValues; readonly files: RecordFiles };
  readonly onClose: () => void;
  readonly onSaved: () => void;
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
