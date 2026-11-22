import type { Proposal } from "@t45/contracts/models/Workflow";
import type { StepView } from "@t45/contracts/resources/Workflows";
import {
  CheckIcon,
  CircleHelpIcon,
  EqualApproximatelyIcon,
  ListFilterIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "~/i18n/locale";
import { ExternalUrl } from "../ExternalUrl";
import { Button } from "../ui/button";

type Assessment = NonNullable<Proposal["comparison"]>["assessments"][number];
type Source = NonNullable<StepView["comparisonSources"]>[string]["records"][number];
const states = {
  different: {
    label: "Different",
    Icon: XIcon,
    color: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    order: 0,
  },
  less_similar: {
    label: "Less similar",
    Icon: MinusIcon,
    color: "bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100",
    order: 1,
  },
  missing: {
    label: "Missing evidence",
    Icon: CircleHelpIcon,
    color: "bg-muted text-muted-foreground",
    order: 2,
  },
  very_similar: {
    label: "Very similar",
    Icon: EqualApproximatelyIcon,
    color: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    order: 3,
  },
  equal: {
    label: "Equal",
    Icon: CheckIcon,
    color: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    order: 4,
  },
} as const;

export function ComparisonCriteriaTable({
  source,
  assessments,
}: {
  readonly source: Source;
  readonly assessments: ReadonlyArray<Assessment>;
}) {
  const t = useTranslation();
  const [hideEqual, setHideEqual] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = source.criteria
    .map((criterion) => {
      const assessment = assessments.find((row) => row.criterionId === criterion.id);
      const status = assessment?.status ?? "missing";
      const state = states[status];
      const rank = status === "equal" ? 10 : state.order + (assessment?.isImportant ? 0 : 5);
      return { criterion, assessment, state, status, rank };
    })
    .sort((a, b) => a.rank - b.rank);
  if (!rows.length) return null;
  return (
    <section aria-label={t("Key characteristics")} className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h3 className="font-semibold">{t("Key characteristics")}</h3>
        {rows.some((row) => row.status === "equal") && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={hideEqual}
            onClick={() => setHideEqual(!hideEqual)}
          >
            <ListFilterIcon />
            {hideEqual ? t("Show equal values") : t("Hide equal values")}
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table
          aria-label={t("Key characteristics")}
          className="w-full min-w-[35rem] border-collapse text-left text-sm"
        >
          <thead className="border-y bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {[t("Characteristic"), t("Source value"), t("Proposed record"), t("Comparison")].map(
                (label) => (
                  <th scope="col" key={label} className="px-4 py-2 font-medium">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((row) => !hideEqual || row.status !== "equal")
              .map(({ criterion, assessment, state }) => {
                const Icon = state.Icon;
                const badge = (
                  <span
                    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ${state.color}`}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {t(state.label)}
                  </span>
                );
                return (
                  <Fragment key={criterion.id}>
                    <tr className="border-b last:border-b-0 align-top">
                      <th scope="row" className="w-1/5 px-4 py-2.5 font-medium">
                        {criterion.name}
                      </th>
                      <td className="w-[29%] px-4 py-2.5 wrap-anywhere">{criterion.value}</td>
                      <td className="px-4 py-2.5 wrap-anywhere">
                        {assessment?.value ?? (
                          <span className="text-muted-foreground">{t("Not provided")}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {assessment ? (
                          <button
                            type="button"
                            aria-label={t("Evidence for {0}", criterion.name)}
                            aria-expanded={expanded === criterion.id}
                            className="cursor-pointer rounded-md underline-offset-2 hover:underline"
                            onClick={() =>
                              setExpanded(expanded === criterion.id ? null : criterion.id)
                            }
                          >
                            {badge}
                            <span aria-hidden="true" className="ms-1 text-xs text-muted-foreground">
                              {expanded === criterion.id ? "▴" : "▾"}
                            </span>
                          </button>
                        ) : (
                          badge
                        )}
                      </td>
                    </tr>
                    {expanded === criterion.id && assessment && (
                      <tr>
                        <td colSpan={4} className="border-b bg-muted/30 px-4 py-2 text-sm">
                          <strong>{t("Evidence")}</strong> · {assessment.evidence}
                          {assessment.sourceUrl && (
                            <div className="mt-1">
                              <ExternalUrl href={assessment.sourceUrl}>{t("Source")}</ExternalUrl>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
        {hideEqual && rows.every((row) => row.status === "equal") && (
          <p className="p-3 text-sm text-muted-foreground">{t("All compared values match.")}</p>
        )}
      </div>
    </section>
  );
}
