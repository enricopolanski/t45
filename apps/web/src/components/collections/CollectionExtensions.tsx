import { useTranslation } from "~/i18n/locale";
import { type Collection, linksParentByKey } from "@t45/contracts/models/Collection";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function CollectionExtensions({
  parent,
  collections,
  onSaved,
}: {
  readonly parent: Collection;
  readonly collections: ReadonlyArray<Collection>;
  readonly onSaved: () => void;
}) {
  const t = useTranslation();
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [categoryFieldId, setCategoryFieldId] = useState<string | null>(null);
  const [categoryValue, setCategoryValue] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const children = collections.filter(
    ({ extension }) => extension?.parentCollectionId === parent.id,
  );
  const parentIds = new Set(
    collections.flatMap(({ extension }) =>
      extension === undefined ? [] : [extension.parentCollectionId],
    ),
  );
  const candidates = collections.filter(
    (collection) =>
      collection.id !== parent.id &&
      collection.extension === undefined &&
      !parentIds.has(collection.id) &&
      linksParentByKey(collection, parent.id),
  );
  const categoryFields = parent.fields
    .filter((field) => field.type === "select")
    .filter(({ options }) => options.length > 0);
  const categoryField = categoryFields.find(({ id }) => id === categoryFieldId);
  const attach = () => {
    if (collectionId === null || categoryFieldId === null || categoryValue === null) return;
    setIsSaving(true);
    setError(null);
    void api("collections.setExtension", {
      collectionId,
      extension: { parentCollectionId: parent.id, categoryFieldId, categoryValue },
    }).then(
      () => {
        setCollectionId(null);
        setIsSaving(false);
        onSaved();
      },
      (cause: unknown) => {
        setError(describeFailure(cause));
        setIsSaving(false);
      },
    );
  };

  return (
    <section
      aria-label={t("Subcollections")}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 className="text-sm font-medium">{t("Subcollections")}</h2>
      {children.length > 0 || candidates.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Subcollections use this collection's access settings.")}
        </p>
      ) : null}
      {children.map((child) => (
        <div key={child.id} className="flex items-center justify-between gap-2">
          <span className="text-sm">
            {child.title} · {child.extension?.categoryValue}
          </span>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/settings/collections/$collectionId/edit"
                params={{ collectionId: parent.id }}
                search={{ subcollection: child.id }}
              />
            }
          >
            {t("Edit")}
          </Button>
        </div>
      ))}
      {candidates.length === 0 || categoryFields.length === 0 ? (
        children.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("Add a category select and a collection keyed by a link to this one.")}
          </p>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={collectionId} onValueChange={setCollectionId} disabled={isSaving}>
            <SelectTrigger aria-label={t("Subcollection")}>
              <SelectValue placeholder={t("Subcollection")}>
                {(id: string | null) =>
                  candidates.find((collection) => collection.id === id)?.title
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map(({ id, title }) => (
                <SelectItem key={id} value={id}>
                  {title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={categoryFieldId}
            onValueChange={(id) => {
              setCategoryFieldId(id);
              setCategoryValue(null);
            }}
            disabled={isSaving}
          >
            <SelectTrigger aria-label={t("Category field")}>
              <SelectValue placeholder={t("Category field")}>
                {(id: string | null) => categoryFields.find((field) => field.id === id)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {categoryFields.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={categoryValue}
            onValueChange={setCategoryValue}
            disabled={isSaving || categoryField === undefined}
          >
            <SelectTrigger aria-label={t("Category value")}>
              <SelectValue placeholder={t("Category value")} />
            </SelectTrigger>
            <SelectPopup>
              {categoryField?.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            onClick={attach}
            disabled={
              isSaving ||
              collectionId === null ||
              categoryField === undefined ||
              categoryValue === null
            }
          >
            {t("Attach subcollection")}
          </Button>
        </div>
      )}
      {error === null ? null : <ErrorText text={error} />}
    </section>
  );
}
