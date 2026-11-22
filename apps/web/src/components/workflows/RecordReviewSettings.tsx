import { useTranslation } from "~/i18n/locale";
import type { RecordEntryReview } from "@t45/contracts/models/Field";
import { canReviewEntryField } from "@t45/contracts/models/Workflow";
import { ClipboardCheckIcon } from "lucide-react";
import { useState } from "react";

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
import { Field } from "../ui/field";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { DraftField } from "./workflowLogic";

type Group = Extract<DraftField, { type: "group" }>;

const NONE = "";

export function RecordReviewSettings({
  group,
  fields,
  onChange,
  disabled,
}: {
  readonly group: Group;
  readonly fields: ReadonlyArray<DraftField>;
  readonly onChange: (group: Group) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const [draft, setDraft] = useState<RecordEntryReview | null>(null);
  const records = fields.filter((field) => field.type === "records");
  const keys = group.fields.filter((field) => field.type === "text");
  if (
    group.recordReview === undefined &&
    (records.length === 0 ||
      keys.length === 0 ||
      group.fields.length < 2 ||
      !group.fields.every(canReviewEntryField))
  )
    return null;
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          setDraft(
            group.recordReview ?? {
              recordsFieldId: NONE,
              recordKeyFieldId: NONE,
            },
          )
        }
      >
        <ClipboardCheckIcon />
        {t("Review by record")}
      </Button>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      >
        {draft === null ? null : (
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{t("Review by record")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Choice
                label={t("Linked records")}
                value={draft.recordsFieldId}
                choices={{
                  [NONE]: t("Choose linked records"),
                  ...Object.fromEntries(records.map(({ id, label }) => [id, label])),
                }}
                onChange={(recordsFieldId) => setDraft({ ...draft, recordsFieldId })}
              />
              <Choice
                label={t("Record key field")}
                value={draft.recordKeyFieldId}
                choices={{
                  [NONE]: t("Choose the entry's record key field"),
                  ...Object.fromEntries(keys.map(({ id, label }) => [id, label])),
                }}
                onChange={(recordKeyFieldId) => setDraft({ ...draft, recordKeyFieldId })}
              />
              <label className="flex w-fit items-center gap-2 text-sm">
                <Switch
                  size="sm"
                  checked={!draft.isConfirmationOptional}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, isConfirmationOptional: !checked })
                  }
                />
                {t("Require confirmation before completing the step")}
              </label>
              <Field label={t("Review message")} size="xs">
                <Textarea
                  placeholder={t("Optional message for the reviewer")}
                  value={draft.message ?? ""}
                  onChange={(event) => setDraft({ ...draft, message: event.target.value })}
                />
              </Field>
            </DialogPanel>
            <DialogFooter>
              {group.recordReview === undefined ? null : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const { recordReview: _, ...rest } = group;
                    onChange(rest);
                    setDraft(null);
                  }}
                >
                  {t("Remove review")}
                </Button>
              )}
              <Button
                type="button"
                disabled={draft.recordsFieldId === NONE || draft.recordKeyFieldId === NONE}
                onClick={() => {
                  const { message, ...review } = draft;
                  const text = message?.trim();
                  onChange({
                    ...group,
                    recordReview: text ? { ...review, message: text } : review,
                  });
                  setDraft(null);
                }}
              >
                {t("Save review")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        )}
      </Dialog>
    </>
  );
}
