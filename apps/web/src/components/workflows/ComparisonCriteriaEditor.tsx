import type { ComparisonCriteria } from "@t45/contracts/models/Field";
import { useState } from "react";
import { useTranslation } from "~/i18n/locale";
import { Choice } from "../fields/LayoutEditor";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type { inputSourcesFor } from "./workflowLogic";

export function ComparisonCriteriaEditor({
  sources,
  mapping,
  onChange,
  disabled,
}: {
  readonly sources: ReturnType<typeof inputSourcesFor>;
  readonly mapping: ComparisonCriteria | undefined;
  readonly onChange: (mapping: ComparisonCriteria | undefined) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mapping);
  const tables = sources.flatMap(({ input, field, label }) => {
    if (
      field.type !== "group" ||
      !field.recordReview ||
      !sources.some(
        (source) =>
          source.input.stepId === input.stepId &&
          source.field.type === "records" &&
          source.field.id === field.recordReview?.recordsFieldId,
      )
    )
      return [];
    return field.fields.flatMap((table) => {
      if (table.type !== "group" || !table.repeatable) return [];
      const columns = table.fields.filter((column) => column.type === "text");
      return columns.length < 2
        ? []
        : [
            {
              stepId: input.stepId,
              reviewId: field.id,
              tableId: table.id,
              label: `${label} › ${table.label}`,
              columns,
            },
          ];
    });
  });
  const index = tables.findIndex(
    (table) =>
      table.stepId === draft?.stepId &&
      table.reviewId === draft.reviewId &&
      table.tableId === draft.tableId,
  );
  const table = tables[index];
  if (!mapping && !tables.length) return null;
  const columns = Object.fromEntries(table?.columns.map(({ id, label }) => [id, label]) ?? []);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setDraft(mapping);
          setOpen(true);
        }}
      >
        {t("Comparison criteria")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("Comparison criteria")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Choice
              label={t("Input characteristics table")}
              value={index < 0 ? "" : String(index)}
              choices={{
                "": t("None"),
                ...Object.fromEntries(tables.map((item, i) => [String(i), item.label])),
              }}
              onChange={(value) => {
                const selected = value === "" ? undefined : tables[Number(value)];
                setDraft(
                  selected
                    ? {
                        stepId: selected.stepId,
                        reviewId: selected.reviewId,
                        tableId: selected.tableId,
                        nameId: selected.columns[0]!.id,
                        valueId: selected.columns[1]!.id,
                      }
                    : undefined,
                );
              }}
            />
            {draft && table && (
              <>
                <Choice
                  label={t("Characteristic")}
                  value={draft.nameId}
                  choices={columns}
                  onChange={(nameId) => setDraft({ ...draft, nameId })}
                />
                <Choice
                  label={t("Source value")}
                  value={draft.valueId}
                  choices={columns}
                  onChange={(valueId) => setDraft({ ...draft, valueId })}
                />
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              disabled={!!table && draft?.nameId === draft?.valueId}
              onClick={() => {
                onChange(table ? draft : undefined);
                setOpen(false);
              }}
            >
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
