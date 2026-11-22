import { translate, useTranslation } from "~/i18n/locale";
import type { Collection } from "@t45/contracts/models/Collection";
import { Fields } from "@t45/contracts/models/Field";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";

import { api } from "../../rpc/api";
import { useApiQuery } from "../../state/rpc";
import {
  ColumnSwitch,
  FieldsEditor,
  LinkDisplaySelect,
  MarkdownSwitch,
  OptionsEditor,
} from "../fields/FieldsEditor";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { PersonPicker } from "../work/PersonPicker";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { WorkFrame } from "../work/WorkFrame";
import { actorName } from "../work/workLogic";
import { useWorkflowData } from "../workflows/useWorkflowData";
import { CollectionLayoutButton } from "./CollectionLayout";
import { CollectionExtensions } from "./CollectionExtensions";
import { collectionListQuery } from "./collectionQueries";
import { blankField, type DraftField, FIELD_TYPES } from "../workflows/workflowLogic";

const encodeFields = Schema.encodeSync(Fields);
const cleanFields = Schema.decodeSync(Fields);

interface Draft {
  readonly title: string;
  readonly fields: ReadonlyArray<DraftField>;
  readonly primaryKeyFieldId: string;
  readonly memberUserIds: ReadonlyArray<string>;
  readonly isPublished: boolean;
}

/** A new collection starts with one text field as its primary key. */
const newDraft = (): Draft => {
  const key = { ...blankField(), label: translate("Key") };
  return {
    title: "",
    fields: [key],
    primaryKeyFieldId: key.id,
    memberUserIds: [],
    isPublished: false,
  };
};

/**
 * A field the collection's records hold: only its display settings can change, and a top-level
 * select's options, as long as no record holds one it loses. A top-level field no record holds
 * can go.
 */
function LockedField({
  field,
  fields,
  isColumn,
  isTopLevel = false,
  onChange,
  onRemove,
  disabled,
}: {
  readonly field: DraftField;
  readonly fields: ReadonlyArray<DraftField>;
  readonly isColumn: boolean;
  readonly isTopLevel?: boolean;
  readonly onChange: (field: DraftField) => void;
  readonly onRemove?: (() => void) | undefined;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{field.label}</span>
        <span className="text-xs text-muted-foreground">{t(FIELD_TYPES[field.type])}</span>
        <LinkDisplaySelect field={field} fields={fields} onChange={onChange} disabled={disabled} />
        <MarkdownSwitch field={field} onChange={onChange} disabled={disabled} />
        <span className="ml-auto flex items-center gap-1">
          {isColumn ? <ColumnSwitch field={field} onChange={onChange} disabled={disabled} /> : null}
          {onRemove === undefined ? null : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("Remove {0}", t("field {0}", field.label))}
              onClick={onRemove}
              disabled={disabled}
            >
              <XIcon />
            </Button>
          )}
        </span>
      </div>
      {isTopLevel && field.type === "select" ? (
        <OptionsEditor field={field} onChange={onChange} disabled={disabled} />
      ) : null}
      {field.type === "group" ? (
        <div className="flex flex-col gap-1 pl-4">
          {field.fields.map((child, at) => (
            <LockedField
              key={child.id}
              field={child}
              fields={field.fields}
              isColumn={field.repeatable && field.layout?.table?.columns === undefined}
              onChange={(changed) => onChange({ ...field, fields: field.fields.with(at, changed) })}
              disabled={disabled}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where an admin defines a collection: its title, fields, primary key and the members who use its
 * records. Once it has records, its fields only grow.
 */
export function CollectionEditor({
  collectionId,
  parentCollectionId,
}: {
  readonly collectionId: string | null;
  readonly parentCollectionId?: string;
}) {
  const t = useTranslation();
  const id = useId();
  const navigate = useNavigate();
  const directory = useWorkDirectory();
  const { data: collections, refresh } = useApiQuery(collectionListQuery);
  const linkable = collections ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  // The layout saves on its own, apart from the draft.
  const [layout, setLayout] = useState<NonNullable<Collection["layout"]>>({});
  const load = useCallback(async () => {
    if (collectionId === null) return { collection: null, hasRecords: false };
    const [collection, { records }] = await Promise.all([
      api("collections.get", { collectionId }),
      api("collections.searchRecords", { collectionId, limit: 1 }),
    ]);
    return { collection, hasRecords: records.length > 0 };
  }, [collectionId]);
  const onLoad = useCallback(({ collection }: Awaited<ReturnType<typeof load>>) => {
    setLayout(collection?.layout ?? {});
    setDraft(
      collection === null
        ? newDraft()
        : {
            title: collection.title,
            fields: encodeFields(collection.fields),
            primaryKeyFieldId: collection.primaryKeyFieldId,
            memberUserIds: collection.memberUserIds,
            isPublished: collection.isPublished,
          },
    );
  }, []);
  const { detail, busy, error, run } = useWorkflowData(load, onLoad);
  const title = collectionId === null ? t("New collection") : t("Edit collection");
  if (detail === null || draft === null)
    return (
      <WorkFrame title={title}>
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? t("Loading…")}
        </p>
      </WorkFrame>
    );
  const extension = detail.collection?.extension;
  if (parentCollectionId !== undefined && extension?.parentCollectionId !== parentCollectionId)
    return (
      <Navigate
        replace
        to="/settings/collections/$collectionId/edit"
        params={{ collectionId: parentCollectionId }}
      />
    );
  if (parentCollectionId === undefined && extension !== undefined && collectionId !== null)
    return (
      <Navigate
        replace
        to="/settings/collections/$collectionId/edit"
        params={{ collectionId: extension.parentCollectionId }}
        search={{ subcollection: collectionId }}
      />
    );
  const { hasRecords } = detail;
  // A layout's columns replace "Show in table".
  const hasLayoutColumns = layout.table?.columns !== undefined;
  // Fields the records were saved with lead the draft; removing one leaves the rest in place.
  const savedIds = hasRecords ? (detail.collection?.fields ?? []).map(({ id }) => id) : [];
  const locked = draft.fields.filter(({ id }) => savedIds.includes(id));
  const editable = draft.fields.filter(({ id }) => !savedIds.includes(id));
  const keyChoices = draft.fields.filter(
    (field) => field.type === "text" || field.type === "foreignKey",
  );
  const save = () =>
    void run(async () => {
      const payload = { ...draft, fields: cleanFields(draft.fields) };
      const saved =
        collectionId === null
          ? await api("collections.create", payload)
          : await api("collections.update", { collectionId, ...payload });
      refresh();
      await (extension === undefined
        ? navigate({
            to: "/settings/collections/$collectionId",
            params: { collectionId: saved.id },
          })
        : navigate({
            to: "/settings/collections/$collectionId/edit",
            params: { collectionId: extension.parentCollectionId },
          }));
    });
  return (
    <WorkFrame
      title={title}
      actions={
        extension === undefined ? null : (
          <Button
            variant="outline"
            render={
              <Link
                to="/settings/collections/$collectionId/edit"
                params={{ collectionId: extension.parentCollectionId }}
              />
            }
          >
            {t("Subcollections")}
          </Button>
        )
      }
    >
      {error && <ErrorText text={error} />}
      <section
        aria-label={t("Collection")}
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-title`}>{t("Title")}</Label>
          <Input
            id={`${id}-title`}
            placeholder={t("Amazon listings")}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("Fields")}</span>
            {detail.collection === null ? null : (
              <CollectionLayoutButton
                collection={{ ...detail.collection, layout }}
                disabled={busy}
                onSaved={setLayout}
              />
            )}
          </div>
          {hasRecords ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t(
                  "This collection has records: add fields, but its fields and primary key stay as they are. You can change which show in the table and where links are displayed, and remove fields or select options that no record holds.",
                )}
              </p>
              <ul className="flex flex-col gap-1">
                {locked.map((field, at) => {
                  const setField = (changed: DraftField) =>
                    setDraft({ ...draft, fields: draft.fields.with(at, changed) });
                  return (
                    <li key={field.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
                      <LockedField
                        field={field}
                        fields={draft.fields}
                        isColumn={!hasLayoutColumns && field.id !== draft.primaryKeyFieldId}
                        isTopLevel
                        onChange={setField}
                        onRemove={
                          field.id === draft.primaryKeyFieldId
                            ? undefined
                            : () =>
                                setDraft({
                                  ...draft,
                                  fields: draft.fields.filter((other) => other.id !== field.id),
                                })
                        }
                        disabled={busy}
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <FieldsEditor
            fields={editable}
            siblings={draft.fields}
            depth={0}
            areColumns={!hasLayoutColumns}
            keyFieldId={draft.primaryKeyFieldId}
            collections={linkable}
            areCollectionFields
            onChange={(fields) => setDraft({ ...draft, fields: [...locked, ...fields] })}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-key`}>{t("Primary key")}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "The text or link field whose value identifies a record: saving a record with a key the collection holds replaces that record.",
            )}
          </p>
          <Select
            value={
              keyChoices.some((field) => field.id === draft.primaryKeyFieldId)
                ? draft.primaryKeyFieldId
                : null
            }
            onValueChange={(primaryKeyFieldId) =>
              primaryKeyFieldId === null ? undefined : setDraft({ ...draft, primaryKeyFieldId })
            }
            disabled={busy || hasRecords}
          >
            <SelectTrigger id={`${id}-key`}>
              <SelectValue placeholder={t("Choose a text or link field")}>
                {(fieldId: string) =>
                  keyChoices.find((field) => field.id === fieldId)?.label || t("Untitled field")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {keyChoices.map((field) => (
                <SelectItem key={field.id} value={field.id}>
                  {field.label || t("Untitled field")}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </section>
      {extension === undefined ? (
        <section
          aria-label={t("People")}
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-5"
        >
          <span className="text-sm font-medium">{t("People")}</span>
          <label className="mt-1 flex w-fit items-center gap-2 text-sm">
            <Switch
              size="sm"
              checked={draft.isPublished}
              onCheckedChange={(isPublished) => setDraft({ ...draft, isPublished })}
              aria-describedby={`${id}-publication`}
              disabled={busy}
            />
            {t("Publish to the organization")}
          </label>
          <p id={`${id}-publication`} className="text-xs text-muted-foreground">
            {t("Everyone in the organization can open published collections from the main menu.")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Admins and the people below can edit records.")}
          </p>
          <ul className="flex flex-col gap-1">
            {draft.memberUserIds.map((userId) => {
              const name = actorName(directory, userId);
              return (
                <li key={userId} className="flex items-center gap-2 text-sm">
                  {name}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("Remove {0}", name)}
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        memberUserIds: draft.memberUserIds.filter((other) => other !== userId),
                      })
                    }
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
          <PersonPicker
            aria-label={t("New member")}
            value={null}
            onChange={(userId) =>
              draft.memberUserIds.includes(userId)
                ? undefined
                : setDraft({ ...draft, memberUserIds: [...draft.memberUserIds, userId] })
            }
            placeholder={t("Add a member")}
            disabled={busy}
          />
        </section>
      ) : null}
      {extension === undefined && detail.collection !== null ? (
        <CollectionExtensions parent={detail.collection} collections={linkable} onSaved={refresh} />
      ) : null}
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {collectionId === null ? t("Create collection") : t("Save collection")}
        </Button>
      </div>
    </WorkFrame>
  );
}
