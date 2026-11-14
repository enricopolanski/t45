import { Fields } from "@t45/contracts/models/Field";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";

import { api } from "../../rpc/api";
import { FieldsEditor } from "../fields/FieldsEditor";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PersonPicker } from "../work/PersonPicker";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { WorkFrame } from "../work/WorkFrame";
import { actorName } from "../work/workLogic";
import { useWorkflowData } from "../workflows/useWorkflowData";
import { blankField, type DraftField, FIELD_TYPES } from "../workflows/workflowLogic";

const encodeFields = Schema.encodeSync(Fields);
const cleanFields = Schema.decodeSync(Fields);

interface Draft {
  readonly title: string;
  readonly fields: ReadonlyArray<DraftField>;
  readonly primaryKeyFieldId: string;
  readonly memberUserIds: ReadonlyArray<string>;
}

/** A new collection starts with one text field as its primary key. */
const newDraft = (): Draft => {
  const key = { ...blankField(), label: "Key" };
  return { title: "", fields: [key], primaryKeyFieldId: key.id, memberUserIds: [] };
};

/**
 * Where an admin defines a collection: its title, fields, primary key and the members who use its
 * records. Once it has records, its fields only grow.
 */
export function CollectionEditor({ collectionId }: { readonly collectionId: string | null }) {
  const id = useId();
  const navigate = useNavigate();
  const directory = useWorkDirectory();
  const [draft, setDraft] = useState<Draft | null>(null);
  const load = useCallback(async () => {
    if (collectionId === null) return { collection: null, hasRecords: false };
    const [collection, { records }] = await Promise.all([
      api("collections.get", { collectionId }),
      api("collections.searchRecords", { collectionId, limit: 1 }),
    ]);
    return { collection, hasRecords: records.length > 0 };
  }, [collectionId]);
  const onLoad = useCallback(
    ({ collection }: Awaited<ReturnType<typeof load>>) =>
      setDraft(
        collection === null
          ? newDraft()
          : {
              title: collection.title,
              fields: encodeFields(collection.fields),
              primaryKeyFieldId: collection.primaryKeyFieldId,
              memberUserIds: collection.memberUserIds,
            },
      ),
    [],
  );
  const { detail, busy, error, run } = useWorkflowData(load, onLoad);
  const title = collectionId === null ? "New collection" : "Edit collection";
  if (detail === null || draft === null)
    return (
      <WorkFrame title={title}>
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  const { hasRecords } = detail;
  const locked = hasRecords ? encodeFields(detail.collection?.fields ?? []) : [];
  const editable = draft.fields.slice(locked.length);
  const keyChoices = draft.fields.filter((field) => field.type === "text");
  const save = () =>
    void run(async () => {
      const payload = { ...draft, fields: cleanFields(draft.fields) };
      const saved =
        collectionId === null
          ? await api("collections.create", payload)
          : await api("collections.update", { collectionId, ...payload });
      await navigate({
        to: "/settings/collections/$collectionId",
        params: { collectionId: saved.id },
      });
    });
  return (
    <WorkFrame title={title}>
      {error && <ErrorText text={error} />}
      <section
        aria-label="Collection"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            id={`${id}-title`}
            placeholder="Amazon listings"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Fields</span>
          {hasRecords ? (
            <>
              <p className="text-xs text-muted-foreground">
                This collection has records: add fields, but its fields and primary key stay as they
                are.
              </p>
              <ul className="flex flex-col gap-1">
                {locked.map((field) => (
                  <li
                    key={field.id}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{field.label}</span>
                    <span className="text-xs text-muted-foreground">{FIELD_TYPES[field.type]}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <FieldsEditor
            fields={editable}
            depth={0}
            onChange={(fields) => setDraft({ ...draft, fields: [...locked, ...fields] })}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-key`}>Primary key</Label>
          <p className="text-xs text-muted-foreground">
            The text field whose value identifies a record: saving a record with a key the
            collection holds replaces that record.
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
              <SelectValue placeholder="Choose a text field">
                {(fieldId: string) =>
                  keyChoices.find((field) => field.id === fieldId)?.label || "Untitled field"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {keyChoices.map((field) => (
                <SelectItem key={field.id} value={field.id}>
                  {field.label || "Untitled field"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </section>
      <section
        aria-label="People"
        className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-5"
      >
        <span className="text-sm font-medium">People</span>
        <p className="text-xs text-muted-foreground">
          Admins and these members see and edit its records.
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
                  aria-label={`Remove ${name}`}
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
          aria-label="New member"
          value={null}
          onChange={(userId) =>
            draft.memberUserIds.includes(userId)
              ? undefined
              : setDraft({ ...draft, memberUserIds: [...draft.memberUserIds, userId] })
          }
          placeholder="Add a member"
          disabled={busy}
        />
      </section>
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {collectionId === null ? "Create collection" : "Save collection"}
        </Button>
      </div>
    </WorkFrame>
  );
}
