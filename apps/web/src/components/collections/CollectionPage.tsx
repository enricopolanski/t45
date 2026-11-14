import type { Collection } from "@t45/contracts/models/Collection";
import { defaultValues, type FieldValues } from "@t45/contracts/models/Field";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { WorkFrame } from "../work/WorkFrame";
import { RecordDialog, RecordTable } from "./Records";

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
  const [isReordering, setIsReordering] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [open, setOpen] = useState<{
    readonly values: FieldValues;
    readonly files: CollectionRecordView["files"];
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

  const reorderColumns = (columnOrder: ReadonlyArray<string>) => {
    setIsSavingOrder(true);
    setError(null);
    void api("collections.reorderColumns", { collectionId, columnOrder }).then(
      (saved) => {
        setCollection(saved);
        setIsSavingOrder(false);
      },
      (cause: unknown) => {
        setError(describeFailure(cause));
        setIsSavingOrder(false);
      },
    );
  };

  if (collection === null)
    return (
      <WorkFrame title="Collection">
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
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
      <div className="flex items-center gap-4">
        <Input
          type="search"
          aria-label="Search records"
          placeholder="Search records"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {isAdmin ? (
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch size="sm" checked={isReordering} onCheckedChange={setIsReordering} />
            Reorder
          </label>
        ) : null}
      </div>
      {error && <ErrorText text={error} />}
      {found !== null && found.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {text.trim() === "" ? "No records yet." : "No record matches."}
        </p>
      ) : null}
      {found !== null && (found.records.length > 0 || isReordering) ? (
        <RecordTable
          label="Records"
          collection={collection}
          records={found.records}
          onOpen={(record) => setOpen({ values: record.values, files: record.files })}
          reorder={
            isAdmin && isReordering
              ? { disabled: isSavingOrder, onChange: reorderColumns }
              : undefined
          }
        />
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
