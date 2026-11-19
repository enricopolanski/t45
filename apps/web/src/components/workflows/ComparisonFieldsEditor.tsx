import type { Collection } from "@t45/contracts/models/Collection";
import type { ComparisonFields, DerivedComparisonField } from "@t45/contracts/models/Field";
import { PencilIcon } from "lucide-react";
import { useId, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { AddButton } from "../fields/FieldsEditor";
import { MoveButtons } from "../fields/LayoutEditor";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import {
  listComparisonFields,
  orderComparisonFields,
  resolveComparisonFields,
} from "../work/recordComparisonFields";
import { DerivedComparisonFieldDialog } from "./DerivedComparisonFieldDialog";
import { moveEntry } from "./workflowLogic";

export function ComparisonFieldsEditor({
  collection,
  inputCollections,
  fields: comparisonFields,
  onChange,
  disabled,
}: {
  readonly collection: Collection;
  readonly inputCollections: ReadonlyArray<Collection>;
  readonly fields: ComparisonFields | undefined;
  readonly onChange: (fields: ComparisonFields | undefined) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  const [editing, setEditing] = useState<DerivedComparisonField | null>(null);
  const { shown, hidden, order, derived } = resolveComparisonFields(comparisonFields);
  const sources = inputCollections.length > 0 ? inputCollections : [undefined];
  const available = new Map(
    [...sources.flatMap((source) => listComparisonFields(collection, source)), ...derived].map(
      (field) => [field.id, field.label],
    ),
  );
  const sourceFields = inputCollections.flatMap(({ fields }) => fields);
  const collectionFields = [...sourceFields, ...collection.fields];
  const automaticFields = new Set(
    collectionFields
      .filter((field) => field.isDetailOnly !== true || (field.type === "text" && field.isMarkdown))
      .map((field) => field.id),
  );
  const automaticOrder = [...available.keys()].filter((key) => automaticFields.has(key));
  const defaultOrder = [...automaticOrder, ...derived.map(({ id }) => id)];
  const fields =
    comparisonFields === undefined
      ? undefined
      : (shown ??
        orderComparisonFields(
          defaultOrder.filter((key) => !hidden.includes(key)),
          (key) => key,
          order,
        ));
  const setFields = (next: ReadonlyArray<string>, definitions = derived) => {
    const defaults = [...automaticOrder, ...definitions.map(({ id }) => id)];
    const kept = defaults.filter((key) => next.includes(key));
    if (shown !== undefined || kept.length !== next.length) {
      onChange(definitions.length === 0 ? next : { shown: next, derived: definitions });
      return;
    }
    onChange({
      hidden: defaults.filter((key) => !next.includes(key)),
      ...(kept.every((key, index) => key === next[index]) ? {} : { order: next }),
      ...(definitions.length === 0 ? {} : { derived: definitions }),
    });
  };
  const editingExisting = editing !== null && derived.some((field) => field.id === editing.id);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium">
        <Switch
          id={id}
          size="sm"
          checked={fields !== undefined}
          onCheckedChange={(enabled) => onChange(enabled ? { hidden: [] } : undefined)}
          disabled={disabled}
        />
        Customize comparison fields
      </label>
      {fields === undefined ? null : (
        <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
          <legend className="text-xs text-muted-foreground">
            Show and order properties in the comparison. Empty properties and values already shown
            in the headings are skipped.
          </legend>
          <ol className="max-h-72 divide-y overflow-y-auto rounded-lg border">
            {[...fields, ...[...available.keys()].filter((key) => !fields.includes(key))].map(
              (key, index) => {
                const label = available.get(key) ?? key;
                const isShown = index < fields.length;
                const definition = derived.find((field) => field.id === key);
                return (
                  <li key={key} className="flex min-h-8 items-center gap-2 px-2 py-0.5">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <Checkbox
                        checked={isShown}
                        onCheckedChange={(checked) =>
                          setFields(
                            checked ? [...fields, key] : fields.filter((field) => field !== key),
                          )
                        }
                        disabled={disabled}
                      />
                      <span className="truncate">{label}</span>
                    </label>
                    {definition === undefined ? null : (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Edit derived field ${label}`}
                        disabled={disabled}
                        onClick={() => setEditing(definition)}
                      >
                        <PencilIcon />
                      </Button>
                    )}
                    {isShown ? (
                      <MoveButtons
                        what={label}
                        onMove={(delta) => setFields(moveEntry(fields, index, delta))}
                        isFirst={disabled || index === 0}
                        isLast={disabled || index === fields.length - 1}
                      />
                    ) : null}
                  </li>
                );
              },
            )}
          </ol>
          <AddButton
            label="Add derived field"
            onClick={() => setEditing({ id: `derived-${randomUUID()}`, label: "", template: "" })}
            disabled={disabled}
          />
          {editing === null ? null : (
            <DerivedComparisonFieldDialog
              field={editing}
              sourceFields={sourceFields}
              proposedFields={collection.fields}
              onChange={(field) => {
                if (editingExisting) {
                  setFields(
                    fields,
                    derived.map((definition) => (definition.id === field.id ? field : definition)),
                  );
                } else {
                  setFields([...fields, field.id], [...derived, field]);
                }
                setEditing(null);
              }}
              onRemove={
                editingExisting
                  ? () => {
                      setFields(
                        fields.filter((key) => key !== editing.id),
                        derived.filter((field) => field.id !== editing.id),
                      );
                      setEditing(null);
                    }
                  : undefined
              }
              onClose={() => setEditing(null)}
            />
          )}
        </fieldset>
      )}
    </div>
  );
}
