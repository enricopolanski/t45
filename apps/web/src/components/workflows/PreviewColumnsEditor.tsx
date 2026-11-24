import {
  PREVIEW_ROW_LABEL,
  type StepPreviewColumn,
  type StepPreviewColumns,
} from "@t45/contracts/models/StepPreview";
import { useTranslation } from "~/i18n/locale";

import { MoveRemove } from "../fields/FieldsEditor";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { listEntries } from "./workflowLogic";

export function PreviewColumnsEditor({
  available,
  columns,
  onChange,
  disabled,
}: {
  readonly available: StepPreviewColumns;
  readonly columns: StepPreviewColumns;
  readonly onChange: (columns: StepPreviewColumns) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const hidden = available.filter(({ id }) => !columns.some((column) => column.id === id));
  const getLabel = (column: StepPreviewColumn) =>
    column.label || (column.id === PREVIEW_ROW_LABEL ? t("Name") : column.id);

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-xs font-medium text-muted-foreground">{t("Preview columns")}</legend>
      {listEntries(columns, onChange).map((place) => {
        const { entry } = place;
        const source = available.find(({ id }) => id === entry.id) ?? entry;
        const label = getLabel(source);
        return (
          <div key={entry.id} className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
              <MoveRemove what={label} place={place} disabled={disabled || columns.length === 1} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field size="xs" label={t("Preview header for {0}", label)}>
                <Input
                  placeholder={label}
                  value={entry.label}
                  onChange={(event) =>
                    place.replace({ ...entry, label: event.currentTarget.value })
                  }
                />
              </Field>
              <Field size="xs" label={t("Preview note for {0}", label)}>
                <Input
                  value={entry.hint ?? ""}
                  onChange={(event) => place.replace({ ...entry, hint: event.currentTarget.value })}
                />
              </Field>
            </div>
          </div>
        );
      })}
      {hidden.length > 0 && (
        <Select
          value={null}
          disabled={disabled}
          onValueChange={(choice) => {
            const column = hidden.find(({ id }) => choice === id);
            if (column) onChange([...columns, column]);
          }}
        >
          <SelectTrigger aria-label={t("Add preview column")}>
            <SelectValue placeholder={t("Add preview column")} />
          </SelectTrigger>
          <SelectPopup>
            {hidden.map((column) => (
              <SelectItem key={column.id} value={column.id}>
                {getLabel(column)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </fieldset>
  );
}
