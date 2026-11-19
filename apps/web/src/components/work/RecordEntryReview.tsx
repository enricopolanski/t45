import { useTranslation } from "~/i18n/locale";
import { defaultValues, type FieldValues, withFieldValue } from "@t45/contracts/models/Field";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import { reviewEntryValues } from "@t45/contracts/models/Workflow";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { buildFieldViews } from "@t45/core/fieldViews";
import { CheckIcon, ClipboardCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../../rpc/api";
import { listImageUrls } from "../collections/RecordDisplay";
import { formatRecordValue } from "../collections/Records";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { newKey } from "../workflows/workflowLogic";
import { FormGrid, layOutForm } from "./StepFields";
import { missingFields, type StepAct } from "./workLogic";

type Review = StepView["recordReviews"][number];
type Entry = Review["entries"][number];

type ReviewItem = {
  readonly review: Review;
  readonly entry: Entry;
  readonly group: FieldView;
  readonly collection: NonNullable<FieldView["collection"]>;
  readonly record: CollectionRecordView;
};

export function RecordEntryReview({
  step,
  item,
  act,
}: {
  readonly step: StepView["step"];
  readonly item: ReviewItem;
  readonly act: StepAct;
}) {
  const t = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!isSaving) setIsOpen(open);
      }}
    >
      <DialogTrigger render={<Button type="button" size="xs" variant="outline" />}>
        <ClipboardCheckIcon />
        {t("Review")}
      </DialogTrigger>
      {isOpen ? (
        <ReviewPanel
          step={step}
          item={item}
          act={act}
          isSaving={isSaving}
          setIsSaving={setIsSaving}
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ReviewPanel({
  step,
  item,
  act,
  isSaving,
  setIsSaving,
  onClose,
}: {
  readonly step: StepView["step"];
  readonly item: ReviewItem;
  readonly act: StepAct;
  readonly isSaving: boolean;
  readonly setIsSaving: (isSaving: boolean) => void;
  readonly onClose: () => void;
}) {
  const t = useTranslation();
  const { review, entry, group, collection, record } = item;
  const [rowId] = useState(() => entry.rowId ?? newKey("row"));
  const [previousValues] = useState(() =>
    entry.rowId === null
      ? null
      : reviewEntryValues(step.values, `${review.groupFieldId}.${entry.rowId}`),
  );
  const [values, setValues] = useState(() => previousValues ?? defaultValues(group.rowFields));
  const pendingValues = useRef<FieldValues>(values);
  const [error, setError] = useState<string | null>(null);
  const [triedConfirm, setTriedConfirm] = useState(false);
  const fields = group.rowFields.filter((field) => field.id !== review.recordKeyFieldId);
  const views = buildFieldViews(fields, values, () => null);
  const form = layOutForm(fields, group.layout, views, "");
  const display = resolveRecordDisplay(collection);
  const title =
    display.title === undefined
      ? record.key
      : formatRecordValue(display.title, record.values[display.title.id], record.files) ||
        record.key;
  const image = listImageUrls(display, record)[0];
  const heading =
    fields.length === 1 && fields[0]?.type === "group" ? fields[0].label : group.label;
  const confirm = () => {
    if (isSaving || entry.hasDuplicateEntries) return;
    setTriedConfirm(true);
    setError(null);
    if (missingFields(buildFieldViews(fields, pendingValues.current, () => null)).length > 0)
      return;
    setIsSaving(true);
    void act(
      () =>
        api("workflows.confirmRecordEntry", {
          stepId: step.id,
          groupFieldId: review.groupFieldId,
          recordKey: entry.recordKey,
          rowId,
          previousValues,
          values: pendingValues.current,
        }),
      true,
    ).then((failure) => {
      setIsSaving(false);
      if (failure === null) onClose();
      else setError(failure);
    });
  };
  return (
    <DialogPopup className="sm:max-w-7xl">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            document.activeElement instanceof HTMLElement &&
            event.currentTarget.contains(document.activeElement)
          )
            document.activeElement.blur();
          confirm();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("Review")} {heading.toLocaleLowerCase()}
          </DialogTitle>
          {review.message === undefined ? (
            <DialogDescription>
              {t("Check and correct the values before confirming.")}
            </DialogDescription>
          ) : (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5">
              <TriangleAlertIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-warning-foreground"
              />
              <DialogDescription>
                <span className="wrap-anywhere whitespace-pre-wrap text-foreground">
                  {review.message}
                </span>
              </DialogDescription>
            </div>
          )}
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5 sm:space-y-7">
            <div className="flex min-w-0 items-center gap-4 rounded-lg border bg-muted/40 p-3 sm:p-4">
              {image === undefined ? null : (
                <img
                  src={image}
                  alt=""
                  className="size-14 shrink-0 rounded bg-background object-contain"
                />
              )}
              <p className="min-w-0 text-sm font-semibold wrap-anywhere">{title}</p>
            </div>
            {entry.hasDuplicateEntries ? (
              <ErrorText
                text={t("This record has multiple entries. Keep one in Fields before confirming.")}
              />
            ) : (
              <fieldset disabled={isSaving} className="min-w-0">
                <FormGrid
                  form={form}
                  wrapEntryText
                  missing={new Set(triedConfirm ? missingFields(views).map(({ key }) => key) : [])}
                  onSave={(key, value) => {
                    const edited = withFieldValue(fields, pendingValues.current, key, value);
                    pendingValues.current = edited;
                    setValues(edited);
                  }}
                  onUpload={() => undefined}
                />
              </fieldset>
            )}
            {error === null ? null : <ErrorText text={error} />}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="success" disabled={isSaving || entry.hasDuplicateEntries}>
            <CheckIcon />
            {isSaving ? t("Confirming…") : t("Confirm")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
