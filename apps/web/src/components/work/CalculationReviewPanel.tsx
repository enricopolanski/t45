import type {
  CalculationCard,
  CalculationEdits,
  CalculationForm,
  CalculationSection,
} from "@t45/contracts/models/CalculationReview";
import type { StepView } from "@t45/contracts/resources/Workflows";
import { useState, type FormEvent } from "react";
import { useLocale, useTranslation } from "~/i18n/locale";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { ExternalUrl } from "../ExternalUrl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { CardFold } from "./CardFold";
import { StepResultHistory, formatStepResultValue } from "./StepResultHistory";

function CardLines({ lines }: { readonly lines: CalculationCard["lines"] }) {
  return lines.map(({ text, link }) => (
    <p key={JSON.stringify([text, link])} className="mt-1 break-words text-sm">
      {link && /^https?:\/\/\S+$/iu.test(link) ? (
        <ExternalUrl href={link}>{text}</ExternalUrl>
      ) : (
        text
      )}
    </p>
  ));
}

function ResultCard({ card }: { readonly card: CalculationCard }) {
  const locale = useLocale();
  return (
    <section aria-label={card.label} className="min-w-0 rounded-lg border bg-muted/20 p-3">
      {card.label && <h3 className="text-sm font-medium">{card.label}</h3>}
      {card.value && (
        <p className="my-1 text-xl font-semibold tabular-nums">
          {formatStepResultValue(card.value, locale, {})}
        </p>
      )}
      <CardLines lines={card.lines} />
      {card.details && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{card.details.label}</summary>
          <CardLines lines={card.details.lines} />
        </details>
      )}
    </section>
  );
}

export function ConfirmCalculationInputs({
  changes,
  onClose,
  onConfirm,
}: {
  readonly changes: NonNullable<StepView["previewChanges"]>;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{changes.title || t("Complete this step?")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm">
            {changes.message || t("Items still to review ({0}).", changes.count)}
          </p>
          {changes.sections.map((section) => (
            <section key={section.key} className="mt-4">
              <h3 className="mb-2 text-sm font-semibold">{section.label}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {section.cards.map((card) => (
                  <ResultCard key={card.label} card={card} />
                ))}
              </div>
            </section>
          ))}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t("Mark done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CalculationInputs({
  form,
  stepId,
  revision,
  onChanged,
}: {
  readonly form: CalculationForm;
  readonly stepId: string;
  readonly revision: string;
  readonly onChanged: () => void;
}) {
  const t = useTranslation();
  const [edited, setEdited] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const values: Record<string, CalculationEdits[string]> = {};
    for (const field of form.editors) {
      const raw = edited[field.id];
      if (raw === undefined) continue;
      const value = raw.trim() === "" ? null : field.type === "number" ? Number(raw) : raw.trim();
      if (typeof value === "number" && !Number.isFinite(value)) return;
      values[field.id] = value;
    }
    if (!Object.keys(values).length) return;
    setSaving(true);
    setError(null);
    try {
      await api("workflows.setCalculatedStepRow", { stepId, rowId: form.rowId, revision, values });
      setEdited({});
      onChanged();
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {form.editors.map((field) => (
          <Field key={field.id} label={field.label} size="xs">
            <Input
              type={field.type}
              step={
                field.type === "number"
                  ? field.decimals === undefined
                    ? "any"
                    : 10 ** -field.decimals
                  : undefined
              }
              min={field.type === "number" ? field.min : undefined}
              max={field.type === "number" ? field.max : undefined}
              size="sm"
              disabled={saving}
              value={edited[field.id] ?? String(field.value ?? "")}
              placeholder={field.sourceValue === null ? "—" : String(field.sourceValue)}
              onChange={(event) => setEdited({ ...edited, [field.id]: event.currentTarget.value })}
            />
          </Field>
        ))}
      </div>
      {error && <ErrorText text={error} />}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={saving || Object.keys(edited).length === 0}
      >
        {form.actionLabel ?? t("Save")}
      </Button>
    </form>
  );
}

function ResultRow({
  row,
  renderForm,
}: {
  readonly row: CalculationSection["rows"][number];
  readonly renderForm: (form: CalculationForm) => React.ReactNode;
}) {
  const locale = useLocale();
  return (
    <div className="border-t py-3 first:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-semibold">{row.label}</h4>
        {row.isVisible && <span className="text-sm">{row.note}</span>}
      </div>
      {row.isVisible && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-3 xl:grid-cols-4">
          {row.metrics.map((metric) => (
            <div key={metric.id}>
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="tabular-nums">
                {metric.value === null
                  ? "—"
                  : new Intl.NumberFormat(locale, {
                      minimumFractionDigits: metric.decimals,
                      maximumFractionDigits: metric.decimals,
                    }).format(metric.value) + (metric.unit ? " " + metric.unit : "")}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {renderForm(row.form)}
    </div>
  );
}

export function CalculationReviewPanel({
  view,
  editable,
  onChanged,
}: {
  readonly view: StepView;
  readonly editable: boolean;
  readonly onChanged: () => void;
}) {
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = view.calculatedReview;
  const result = review?.result;
  if (!review || !result)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("Calculating results…")}
      </p>
    );
  const { ticket, step } = view;
  async function approve(revision: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("workflows.approveCalculatedStep", { stepId: step.id, revision });
      onChanged();
    } catch (error) {
      setError(describeFailure(error));
    } finally {
      setBusy(false);
    }
  }

  function renderForm(form: CalculationForm) {
    if (!editable || !result || form.editors.length === 0) return null;
    const inputs = (
      <fieldset disabled={result.isPending}>
        <CalculationInputs
          form={form}
          stepId={step.id}
          revision={result.revision}
          onChanged={onChanged}
        />
      </fieldset>
    );
    return form.label === undefined ? (
      inputs
    ) : (
      <details className="my-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">{form.label}</summary>
        {inputs}
      </details>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error && <ErrorText text={error} />}
      {result.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Calculating results…")}
        </p>
      )}
      {result.sections.map((section) => {
        const visible = section.rows.filter(({ isVisible }) => isVisible);
        const additional = section.rows.filter(({ isVisible }) => !isVisible);
        return (
          <CardFold title={section.label} key={section.key}>
            <div className="flex justify-end">
              <StepResultHistory
                ticketId={ticket.id}
                stepDefinitionId={step.stepDefinitionId}
                resultKey={section.key}
                labels={review.labels}
                label={section.label}
                showLabel
              />
            </div>
            {section.forms.map((form) => (
              <div key={JSON.stringify([form.rowId, form.editors.map(({ id }) => id)])}>
                {renderForm(form)}
              </div>
            ))}
            {section.cards.map((card) => (
              <ResultCard key={card.label} card={card} />
            ))}
            {visible.map((row) => (
              <ResultRow key={row.id} row={row} renderForm={renderForm} />
            ))}
            {visible.length === 0 && section.emptyRowsLabel && (
              <p className="text-sm text-muted-foreground">{section.emptyRowsLabel}</p>
            )}
            {editable && additional.length > 0 && section.additionalRowsLabel && (
              <details>
                <summary className="w-fit cursor-pointer text-sm font-medium text-primary">
                  {section.additionalRowsLabel}
                </summary>
                {additional.map((row) => (
                  <ResultRow key={row.id} row={row} renderForm={renderForm} />
                ))}
              </details>
            )}
          </CardFold>
        );
      })}
      {editable && (
        <section className="card space-y-3 p-4">
          {result.approvalLabel && (
            <h3 className="text-sm font-semibold">{result.approvalLabel}</h3>
          )}
          {result.isApproved ? (
            <Badge variant="success">{t("Approved")}</Badge>
          ) : (
            <>
              {result.blockingReason && (
                <p className="text-sm text-muted-foreground">{result.blockingReason}</p>
              )}
              <Button
                type="button"
                size="sm"
                disabled={busy || result.isPending || !result.canApprove}
                onClick={() => void approve(result.revision)}
              >
                {t("Approve")}
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
