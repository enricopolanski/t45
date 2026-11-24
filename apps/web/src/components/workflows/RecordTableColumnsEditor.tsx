import type { Collection } from "@t45/contracts/models/Collection";
import { UPDATED_AT_COLUMN, type RecordTableColumns } from "@t45/contracts/models/Field";
import { useId } from "react";

import { useTranslation } from "~/i18n/locale";
import { resolveRecordTable } from "../collections/Records";
import { MoveButtons } from "../fields/LayoutEditor";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { moveEntry } from "./workflowLogic";

export function RecordTableColumnsEditor({
  collection,
  columns,
  onChange,
  disabled,
}: {
  readonly collection: Collection;
  readonly columns: RecordTableColumns | undefined;
  readonly onChange: (columns: RecordTableColumns | undefined) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const id = useId();
  const defaults = resolveRecordTable(collection, t).columns;
  const candidates = new Map([
    ...collection.fields.map(({ id, label }) => [id, label] as const),
    [UPDATED_AT_COLUMN, t("Last update")] as const,
    ...defaults.map(({ id, label }) => [id, label] as const),
  ]);
  const visible = columns?.filter((key) => candidates.has(key));
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium">
        <Switch
          id={id}
          size="sm"
          checked={visible !== undefined}
          onCheckedChange={(enabled) =>
            onChange(enabled ? defaults.map(({ id }) => id) : undefined)
          }
          disabled={disabled}
        />
        {t("Customize linked record columns")}
      </label>
      {visible !== undefined && (
        <fieldset disabled={disabled} className="space-y-1.5">
          <legend className="text-xs text-muted-foreground">{t("Linked record columns")}</legend>
          <ol className="max-h-72 divide-y overflow-y-auto rounded-lg border">
            {[...visible, ...[...candidates.keys()].filter((key) => !visible.includes(key))].map(
              (key, index) => {
                const label = candidates.get(key)!;
                const isShown = index < visible.length;
                return (
                  <li key={key} className="flex min-h-8 items-center gap-2 px-2 py-0.5">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <Checkbox
                        checked={isShown}
                        onCheckedChange={(checked) =>
                          onChange(
                            checked
                              ? [...visible, key]
                              : visible.filter((column) => column !== key),
                          )
                        }
                      />
                      <span className="truncate">{label}</span>
                    </label>
                    {isShown && (
                      <MoveButtons
                        what={label}
                        onMove={(delta) => onChange(moveEntry(visible, index, delta))}
                        isFirst={disabled || index === 0}
                        isLast={disabled || index === visible.length - 1}
                      />
                    )}
                  </li>
                );
              },
            )}
          </ol>
        </fieldset>
      )}
    </div>
  );
}
