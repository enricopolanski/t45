import { type CalculatorLabels, formatCalculatorLabel } from "@t45/contracts/models/StepCalculator";
import type { StepResultValue } from "@t45/contracts/models/StepResultHistory";
import * as DateTime from "effect/DateTime";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useLocale, useTranslation } from "../../i18n/locale";
import { apiQuery, useApiQuery } from "../../state/rpc";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const histories = apiQuery("workflows.getStepResultHistory");

interface HistoryProps {
  readonly ticketId: string;
  readonly stepDefinitionId: string;
  readonly resultKey: string;
  readonly labels: CalculatorLabels;
  readonly latestId?: number | undefined;
}

export function formatStepResultValue(
  field: StepResultValue,
  locale: string,
  labels: CalculatorLabels,
) {
  switch (field.type) {
    case "text":
      return (
        formatCalculatorLabel(labels, `history.value.${field.id}.${field.value}`) ?? field.value
      );
    case "number":
      return new Intl.NumberFormat(locale).format(field.value);
    case "percentage":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
        field.value / 100,
      );
    case "currency":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: field.currency,
        maximumFractionDigits: field.maximumFractionDigits,
      }).format(field.value);
  }
}

function HistoryValues({
  values,
  labels,
  prefix = "",
}: {
  readonly values: ReadonlyArray<StepResultValue>;
  readonly labels: CalculatorLabels;
  readonly prefix?: string;
}) {
  const locale = useLocale();
  if (values.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {values.map((field) => (
        <div key={field.id} className="inline-flex max-w-full flex-wrap items-baseline gap-x-1">
          <dt>{formatCalculatorLabel(labels, `history.field.${prefix}${field.id}`) ?? field.id}</dt>
          <dd className="break-all font-medium text-foreground tabular-nums">
            {formatStepResultValue(field, locale, labels)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Versions({ ticketId, stepDefinitionId, resultKey, latestId, labels }: HistoryProps) {
  const t = useTranslation();
  const locale = useLocale();
  const now = useNowMinute();
  const query = useMemo(
    () => histories({ ticketId, stepDefinitionId, resultKey }),
    [ticketId, stepDefinitionId, resultKey],
  );
  const { data: entries, error, refresh } = useApiQuery(query);
  const loadedId = entries === null ? null : (entries[0]?.id ?? 0);
  useEffect(() => {
    if (loadedId !== null && latestId !== undefined && loadedId < latestId) refresh();
  }, [loadedId, latestId, refresh]);

  if (error) return <ErrorText text={error} />;
  if (!entries) return <p className="text-sm text-muted-foreground">{t("Loading…")}</p>;
  if (entries.length === 0)
    return <p className="text-sm text-muted-foreground">{t("No results recorded yet.")}</p>;
  return (
    <ol className="divide-y">
      {entries.map(({ id, recordedAt, snapshot }, index) => {
        const [primary, ...additional] = snapshot.results;
        return (
          <li key={id}>
            <details open={index === 0} className="group py-3 first:pt-1">
              <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded-sm focus-visible:outline">
                <ChevronRightIcon className="size-4 shrink-0 self-center text-muted-foreground group-open:rotate-90" />
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  {primary ? (
                    <>
                      <span>
                        {formatCalculatorLabel(labels, `history.field.${primary.id}`) ?? primary.id}
                      </span>
                      <strong className="text-base tabular-nums">
                        {formatStepResultValue(primary, locale, labels)}
                      </strong>
                    </>
                  ) : snapshot.groups?.length ? (
                    snapshot.groups.map((group) => (
                      <span key={group.id}>
                        {formatCalculatorLabel(labels, `history.field.${group.id}`) ?? group.id}
                        {" · "}
                        {t(
                          group.rows.length === 1 ? "{0} entry" : "{0} entries",
                          group.rows.length,
                        )}
                      </span>
                    ))
                  ) : (
                    t("No result")
                  )}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <time
                        className="ms-auto shrink-0 text-end text-xs text-muted-foreground"
                        dateTime={DateTime.formatIso(recordedAt)}
                      />
                    }
                  >
                    {formatRelativeTimeLabel(recordedAt, now)}
                  </TooltipTrigger>
                  <TooltipPopup>{formatChatTimestampTooltip(recordedAt)}</TooltipPopup>
                </Tooltip>
              </summary>
              <div className="ms-6 mt-1">
                <HistoryValues values={additional} labels={labels} />
                {snapshot.groups?.map((group) => (
                  <ul key={group.id} className="my-2 divide-y rounded-lg border px-3">
                    {group.rows.map((row) => (
                      <li key={row.id} className="py-2">
                        <HistoryValues
                          values={row.values}
                          labels={labels}
                          prefix={`${group.id}.`}
                        />
                      </li>
                    ))}
                  </ul>
                ))}
                <p className="mt-3 text-xs font-medium text-muted-foreground">
                  {formatCalculatorLabel(labels, "history.sources") ?? t("Sources used")}
                </p>
                {snapshot.sources.length > 0 ? (
                  <ul className="mt-1 divide-y rounded-lg border px-3">
                    {snapshot.sources.map((source) => (
                      <li key={source.id} className="space-y-1 py-2">
                        <p className="break-words text-sm font-medium">{source.title}</p>
                        <HistoryValues values={source.values} labels={labels} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm">{t("No sources recorded.")}</p>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export function StepResultHistory({
  label,
  showLabel = false,
  ...input
}: HistoryProps & { readonly label: string; readonly showLabel?: boolean }) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const title = formatCalculatorLabel(input.labels, "history.title") ?? t("Result history");
  const name = t("{0} for {1}", title, label);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button variant="ghost" size={showLabel ? "sm" : "icon-sm"} aria-label={name} />
              }
            />
          }
        >
          <HistoryIcon />
          {showLabel && title}
        </TooltipTrigger>
        <TooltipPopup>{name}</TooltipPopup>
      </Tooltip>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <DialogPanel>{open && <Versions {...input} />}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
