import type { Collection } from "@t45/contracts/models/Collection";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { PageBreadcrumbLink } from "../PageBreadcrumb";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { FormGrid } from "../work/StepFields";
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
}: {
  readonly collectionId: string;
  readonly recordKey: string;
}) {
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
      <PageBreadcrumbLink to="/settings/collections/$collectionId" params={{ collectionId }}>
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
  if (!isEditing && resolveRecordDisplay(loaded.collection).template === "showcase")
    return (
      <WorkFrame
        title={recordKey}
        parent={parent}
        width="full"
        actions={
          <Button size="sm" onClick={() => setIsEditing(true)}>
            Edit record
          </Button>
        }
      >
        <RecordShowcase collection={loaded.collection} record={loaded.record} />
      </WorkFrame>
    );
  return (
    <RecordForm
      title={recordKey}
      parent={parent}
      collection={loaded.collection}
      record={loaded.record}
    />
  );
}

/** The record's form, saved from the page's actions, which stay put while its fields change size. */
function RecordForm({
  title,
  parent,
  collection,
  record,
}: {
  readonly title: string;
  readonly parent: ReactNode;
  readonly collection: Collection;
  readonly record: CollectionRecordView;
}) {
  const navigate = useNavigate();
  const formId = useId();
  const { editor, form, isBusy, error, save } = useRecordForm(
    collection,
    record,
    () =>
      void navigate({
        to: "/settings/collections/$collectionId",
        params: { collectionId: collection.id },
      }),
  );
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
