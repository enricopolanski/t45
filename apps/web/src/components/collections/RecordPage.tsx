import { canEditRecords, type Collection } from "@t45/contracts/models/Collection";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews } from "@t45/core/fieldViews";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { useSession } from "../../state/session";
import { PageBreadcrumbLink } from "../PageBreadcrumb";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { FormGrid, ReadOnlyFields } from "../work/StepFields";
import { WorkFrame } from "../work/WorkFrame";
import { RecordShowcase } from "./RecordDisplay";
import { useRecordForm } from "./Records";

/**
 * A record of a collection on a page of its own, edited and saved whole; with a showcase layout, shown
 * as one until edited.
 */
export function RecordPage({
  collectionId,
  recordKey,
  isInSettings = false,
}: {
  readonly collectionId: string;
  readonly recordKey: string;
  readonly isInSettings?: boolean;
}) {
  const viewer = useSession();
  const navigate = useNavigate();
  const collectionRoute = isInSettings
    ? "/settings/collections/$collectionId"
    : "/collections/$collectionId";
  const [loaded, setLoaded] = useState<{
    readonly collection: Collection;
    readonly record: CollectionRecordView | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([
      api("collections.get", { collectionId }),
      api("collections.getRecord", { collectionId, key: recordKey }),
    ]).then(
      ([collection, record]) => current && setLoaded({ collection, record }),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [collectionId, recordKey]);

  const parent =
    loaded === null ? undefined : (
      <PageBreadcrumbLink to={collectionRoute} params={{ collectionId }}>
        {loaded.collection.title}
      </PageBreadcrumbLink>
    );
  if (loaded?.record == null)
    return (
      <WorkFrame title={recordKey} parent={parent}>
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ??
            (loaded === null ? "Loading…" : "This collection holds no record with this key.")}
        </p>
      </WorkFrame>
    );
  const { collection, record } = loaded;
  const canEdit = viewer !== null && canEditRecords({ ...viewer, id: viewer.userId }, collection);
  if ((!isEditing || !canEdit) && resolveRecordDisplay(collection).template === "showcase")
    return (
      <WorkFrame
        title={recordKey}
        parent={parent}
        width="full"
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setIsEditing(true)}>
              Edit record
            </Button>
          ) : null
        }
      >
        <RecordShowcase collection={collection} record={record} />
      </WorkFrame>
    );
  if (!canEdit)
    return (
      <WorkFrame title={recordKey} parent={parent}>
        <ReadOnlyFields
          fields={buildFieldViews(
            collection.fields,
            record.values,
            (id) => record.files.find((file) => file.id === id) ?? null,
          )}
        />
      </WorkFrame>
    );
  return (
    <RecordForm
      title={recordKey}
      parent={parent}
      collection={collection}
      record={record}
      onSaved={() => void navigate({ to: collectionRoute, params: { collectionId } })}
    />
  );
}

/** The record's form, saved from the page's actions, which stay put while its fields change size. */
function RecordForm({
  title,
  parent,
  collection,
  record,
  onSaved,
}: {
  readonly title: string;
  readonly parent: ReactNode;
  readonly collection: Collection;
  readonly record: CollectionRecordView;
  readonly onSaved: () => void;
}) {
  const formId = useId();
  const { editor, form, isBusy, error, save } = useRecordForm(collection, record, onSaved);
  return (
    <WorkFrame
      title={title}
      parent={parent}
      actions={
        <Button type="submit" form={formId} size="sm" disabled={isBusy}>
          Save record
        </Button>
      }
    >
      <form
        id={formId}
        aria-label="Record"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <FormGrid {...editor} form={form} />
        {error && <ErrorText text={error} />}
      </form>
    </WorkFrame>
  );
}
