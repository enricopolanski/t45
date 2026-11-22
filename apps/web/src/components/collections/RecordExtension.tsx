import { useTranslation } from "~/i18n/locale";
import type { Collection } from "@t45/contracts/models/Collection";
import { defaultValues } from "@t45/contracts/models/Field";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { buildFieldViews } from "@t45/core/fieldViews";
import { useState } from "react";

import { Button } from "../ui/button";
import { ReadOnlyFields } from "../work/StepFields";
import { RecordDialog } from "./Records";

export function RecordExtension({
  collection,
  record: initialRecord,
  recordKey,
  canEdit,
}: {
  readonly collection: Collection;
  readonly record: CollectionRecordView | null;
  readonly recordKey: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslation();
  const [record, setRecord] = useState(initialRecord);
  const [isEditing, setIsEditing] = useState(false);
  const fields = collection.fields.filter(({ id }) => id !== collection.primaryKeyFieldId);
  return (
    <section
      aria-label={t("Technical details · {0}", collection.title)}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {t("Technical details · {0}", collection.title)}
        </h2>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
            {record === null ? t("Add technical details") : t("Edit technical details")}
          </Button>
        ) : null}
      </div>
      {record === null ? (
        <p className="text-sm text-muted-foreground">
          {t("Technical details have yet to be added.")}
        </p>
      ) : (
        <ReadOnlyFields
          fields={buildFieldViews(
            fields,
            record.values,
            (id) => record.files.find((file) => file.id === id) ?? null,
          )}
        />
      )}
      {isEditing ? (
        <RecordDialog
          collection={{ ...collection, fields }}
          record={
            record ?? {
              values: { ...defaultValues(fields), [collection.primaryKeyFieldId]: recordKey },
              files: [],
            }
          }
          onClose={() => setIsEditing(false)}
          onSaved={(saved) => {
            setRecord(saved);
            setIsEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
