import { useTranslation } from "~/i18n/locale";
import { canEditRecords, type Collection } from "@t45/contracts/models/Collection";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews } from "@t45/core/fieldViews";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api, type ApiSuccess } from "../../rpc/api";
import { useSession } from "../../state/session";
import { PageBreadcrumbLink } from "../PageBreadcrumb";
import { Button } from "../ui/button";
import {
  AlertDialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { FormGrid, ReadOnlyFields } from "../work/StepFields";
import { WorkFrame } from "../work/WorkFrame";
import { RecordShowcase } from "./RecordDisplay";
import { RecordExtension } from "./RecordExtension";
import { formatRecordValue, useRecordForm } from "./Records";

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
  const t = useTranslation();
  const viewer = useSession();
  const navigate = useNavigate();
  const collectionRoute = isInSettings
    ? "/settings/collections/$collectionId"
    : "/collections/$collectionId";
  const [loaded, setLoaded] = useState<{
    readonly collection: Collection;
    readonly record: CollectionRecordView | null;
    readonly extensions: ApiSuccess<"collections.getRecordExtensions">;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([
      api("collections.get", { collectionId }),
      api("collections.getRecord", { collectionId, key: recordKey }),
      api("collections.getRecordExtensions", { collectionId, key: recordKey }),
    ]).then(
      ([collection, record, extensions]) =>
        current && setLoaded({ collection, record, extensions }),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [collectionId, recordKey]);

  if (loaded?.collection.extension !== undefined)
    return (
      <Navigate
        replace
        to={
          isInSettings
            ? "/settings/collections/$collectionId/records/$recordKey"
            : "/collections/$collectionId/records/$recordKey"
        }
        params={{ collectionId: loaded.collection.extension.parentCollectionId, recordKey }}
      />
    );

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
            (loaded === null ? t("Loading…") : t("This collection holds no record with this key."))}
        </p>
      </WorkFrame>
    );
  const { collection, record } = loaded;
  const display = resolveRecordDisplay(collection);
  const titleField = display.title;
  const tabTitle =
    titleField === undefined || collection.layout?.page?.hiddenFields?.includes(titleField.id)
      ? recordKey
      : formatRecordValue(titleField, record.values[titleField.id], record.files).trim() ||
        recordKey;
  const canEdit = viewer !== null && canEditRecords({ ...viewer, id: viewer.userId }, collection);
  const sections = loaded.extensions.map(({ collection: child, record: detail }) => (
    <RecordExtension
      key={child.id}
      collection={child}
      record={detail}
      recordKey={recordKey}
      canEdit={canEdit}
    />
  ));
  if ((!isEditing || !canEdit) && display.template === "showcase")
    return (
      <WorkFrame
        title={recordKey}
        tabTitle={tabTitle}
        parent={parent}
        width="full"
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setIsEditing(true)}>
              {t("Edit record")}
            </Button>
          ) : null
        }
      >
        <RecordShowcase collection={collection} record={record} />
        {sections}
      </WorkFrame>
    );
  if (!canEdit)
    return (
      <WorkFrame title={recordKey} tabTitle={tabTitle} parent={parent}>
        <ReadOnlyFields
          fields={buildFieldViews(
            collection.fields,
            record.values,
            (id) => record.files.find((file) => file.id === id) ?? null,
          )}
        />
        {sections}
      </WorkFrame>
    );
  return (
    <RecordForm
      title={recordKey}
      tabTitle={tabTitle}
      parent={parent}
      collection={collection}
      record={record}
      sections={sections}
      onSaved={() => void navigate({ to: collectionRoute, params: { collectionId } })}
    />
  );
}

/** Deletes the record once confirmed; a record another collection links stays, saying which. */
function DeleteRecordButton({
  collectionId,
  recordKey,
  onDeleted,
}: {
  readonly collectionId: string;
  readonly recordKey: string;
  readonly onDeleted: () => void;
}) {
  const t = useTranslation();
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setIsConfirming(true)}>
        {t("Delete record")}
      </Button>
      <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>{t('Delete record "{0}"?', recordKey)}</DialogTitle>
            <DialogDescription>
              {t("The record and its files are removed for good, wherever they are shown.")}
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorText text={error} />}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("Cancel")}</DialogClose>
            <Button
              variant="destructive"
              onClick={() =>
                void api("collections.deleteRecord", { collectionId, key: recordKey }).then(
                  onDeleted,
                  (cause: unknown) => setError(describeFailure(cause)),
                )
              }
            >
              {t("Delete")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </>
  );
}

/** The record's form, saved from the page's actions, which stay put while its fields change size. */
function RecordForm({
  title,
  tabTitle,
  parent,
  collection,
  record,
  sections,
  onSaved,
}: {
  readonly title: string;
  readonly tabTitle: string;
  readonly parent: ReactNode;
  readonly collection: Collection;
  readonly record: CollectionRecordView;
  readonly sections: ReactNode;
  readonly onSaved: () => void;
}) {
  const t = useTranslation();
  const formId = useId();
  const { editor, form, isBusy, error, save } = useRecordForm(collection, record, onSaved);
  return (
    <WorkFrame
      title={title}
      tabTitle={tabTitle}
      parent={parent}
      actions={
        <>
          <DeleteRecordButton
            collectionId={collection.id}
            recordKey={record.key}
            onDeleted={onSaved}
          />
          <Button type="submit" form={formId} size="sm" disabled={isBusy}>
            {t("Save record")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        aria-label={t("Record")}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <FormGrid {...editor} form={form} />
        {error && <ErrorText text={error} />}
      </form>
      {sections}
    </WorkFrame>
  );
}
