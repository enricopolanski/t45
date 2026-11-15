import type { Collection } from "@t45/contracts/models/Collection";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews } from "@t45/core/fieldViews";
import { useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { LayoutEditor } from "../fields/LayoutEditor";
import { Button } from "../ui/button";
import { layOutForm } from "../work/StepFields";
import { ReadOnlyForm } from "../work/StepInputs";
import { listDefaultColumns, RecordTable } from "./Records";

/** Edits how a collection's records show, previewed with its first 50; saving stores it. */
function CollectionLayoutDialog({
  collection,
  onSaved,
  onClose,
}: {
  readonly collection: Collection;
  readonly onSaved: (collection: Collection) => void;
  readonly onClose: () => void;
}) {
  const [records, setRecords] = useState<ReadonlyArray<CollectionRecordView> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api("collections.searchRecords", { collectionId: collection.id, limit: 50 }).then(
      (found) => current && setRecords(found.records),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [collection.id]);
  return (
    <LayoutEditor
      trail={`Collections · ${collection.title}`}
      title={collection.title}
      fields={collection.fields}
      layout={collection.layout}
      defaultColumns={listDefaultColumns(collection)}
      defaultDialogWidth={768}
      entries={(records ?? []).map((record) => ({ id: record.key, label: record.key }))}
      previewNote={
        records === null
          ? (error ?? "Loading the records…")
          : records.length === 0
            ? "This collection has no records yet."
            : null
      }
      rowsHint="Sorting changes only how records show, not the order kept, and sorts the records loaded so far."
      renderTable={(layout, onOpen) => (
        <RecordTable
          label="Records"
          collection={{ ...collection, layout: layout ?? {} }}
          records={records ?? []}
          onOpen={(record) => onOpen(record.key)}
        />
      )}
      renderForm={(layout, key) => {
        const record = records?.find((candidate) => candidate.key === key);
        if (record === undefined) return null;
        const views = buildFieldViews(
          collection.fields,
          record.values,
          (id) => record.files.find((file) => file.id === id) ?? null,
        );
        return <ReadOnlyForm form={layOutForm(collection.fields, layout, views, "")} />;
      }}
      isSaving={isSaving}
      error={records === null ? null : error}
      onSave={(layout) => {
        setIsSaving(true);
        setError(null);
        const { title, fields, primaryKeyFieldId, memberUserIds } = collection;
        void api("collections.update", {
          collectionId: collection.id,
          title,
          fields,
          primaryKeyFieldId,
          memberUserIds,
          layout: layout ?? {},
        }).then(onSaved, (cause: unknown) => {
          setIsSaving(false);
          setError(describeFailure(cause));
        });
      }}
      onClose={onClose}
    />
  );
}

/** Opens the layout editor of a collection's records; the layout saves on its own. */
export function CollectionLayoutButton({
  collection,
  disabled,
  onSaved,
}: {
  readonly collection: Collection;
  readonly disabled: boolean;
  readonly onSaved: (layout: NonNullable<Collection["layout"]>) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
      >
        Layout
      </Button>
      {isOpen ? (
        <CollectionLayoutDialog
          collection={collection}
          onSaved={(next) => {
            onSaved(next.layout ?? {});
            setIsOpen(false);
          }}
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </>
  );
}
