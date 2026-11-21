import { useTranslation } from "~/i18n/locale";
import { openProposals } from "@t45/contracts/models/Workflow";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { useState } from "react";

import { MarkdownText } from "../markdown/MarkdownText";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ErrorText } from "../ui/error-text";
import { FieldValue } from "./StepFields";
import { RecordComparison } from "./RecordComparison";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

type Proposal = StepView["proposals"][number];

/** The view of the field at `key`, among `fields` or in their groups' rows. */
const findField = (fields: ReadonlyArray<FieldView>, key: string): FieldView | null => {
  for (const field of fields) {
    if (field.key === key) return field;
    for (const row of field.rows) {
      const found = findField(row.fields, key);
      if (found !== null) return found;
    }
  }
  return null;
};

/** What a proposal would change: the record it links, or the field's value now and proposed. */
function ProposedValue({
  field,
  proposal,
  inputs,
  criteriaSources,
}: {
  readonly field: FieldView;
  readonly proposal: Proposal;
  readonly inputs: ReadonlyArray<FieldView>;
  readonly criteriaSources: NonNullable<StepView["comparisonSources"]>[string] | undefined;
}) {
  const t = useTranslation();
  if (field.type === "records") {
    return field.collection === null || proposal.record === null ? (
      <p className="text-sm text-muted-foreground">{t("The record is gone.")}</p>
    ) : (
      <RecordComparison
        key={proposal.id}
        inputs={inputs}
        collection={field.collection}
        record={proposal.record}
        rationale={proposal.whyYes}
        comparison={proposal.comparison}
        criteriaSources={criteriaSources}
        comparisonFields={field.comparisonFields}
      />
    );
  }
  const { linkUrl: _, ...unlinked } = field;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <ValueBox term={t("Now")} field={field} />
      <ValueBox term={t("Proposed")} field={{ ...unlinked, value: proposal.value }} />
    </dl>
  );
}

function ProposalComment({ proposal }: { readonly proposal: Proposal }) {
  const t = useTranslation();
  return (
    <section
      aria-label={t("Comment")}
      className="flex flex-col gap-3 rounded-lg border p-3 text-sm"
    >
      <h3 className="font-semibold">{t("Comment")}</h3>
      <section aria-label={t("Why it fits")} className="flex min-w-0 flex-col gap-1">
        <h4 className="font-medium">{t("Why it fits")}</h4>
        <MarkdownText text={proposal.whyYes} className="wrap-anywhere" />
      </section>
      <section aria-label={t("Why it may not")} className="flex min-w-0 flex-col gap-1">
        <h4 className="font-medium">{t("Why it may not")}</h4>
        <MarkdownText text={proposal.whyNo || t("Nothing against it.")} className="wrap-anywhere" />
      </section>
    </section>
  );
}

function ValueBox({ term, field }: { readonly term: string; readonly field: FieldView }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd>
        <FieldValue field={field} />
      </dd>
    </div>
  );
}

/**
 * The open proposals of a step, reviewed one at a time, best first: each approved fills its field
 * or links its record, each discarded is never proposed again. `onReview` answers an error
 * message, or null once the step shows the change.
 */
export function ProposalReview({
  view,
  onReview,
}: {
  readonly view: StepView;
  readonly onReview: (proposal: Proposal, isApproved: boolean) => Promise<string | null>;
}) {
  const t = useTranslation();
  const directory = useWorkDirectory();
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postponed, setPostponed] = useState<ReadonlyArray<string>>([]);
  const open = openProposals(view.proposals);
  const remaining = open.filter((candidate) => !postponed.includes(candidate.id));
  const proposal = remaining[0];
  if (open.length === 0 && !isOpen) return null;
  const field = proposal === undefined ? null : findField(view.fields, proposal.fieldKey);
  const criteriaSources = field && view.comparisonSources?.[field.key];
  const hasScopedRationale = !criteriaSources || proposal?.comparison !== undefined;
  const review = (isApproved: boolean) => {
    if (proposal === undefined) return;
    setIsBusy(true);
    setError(null);
    void onReview(proposal, isApproved).then((failure) => {
      setIsBusy(false);
      setError(failure);
      if (failure === null && remaining.length === 1) setIsOpen(false);
    });
  };
  return (
    <>
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setPostponed([]);
            setIsOpen(true);
          }}
        >
          {t("Review ({0})", open.length)}
        </Button>
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogPopup
          aria-label={t("Review")}
          className={field?.type === "records" ? "sm:max-w-7xl" : "sm:max-w-3xl"}
        >
          <DialogHeader>
            <DialogTitle>
              {field === null ? t("Review") : t("Review {0}", field.label)}
              <span className="ms-2 text-sm font-normal text-muted-foreground tabular-nums">
                {t("{0} left", remaining.length)}
                {postponed.length > 0 ? t(" · {0} postponed", postponed.length) : ""}
              </span>
            </DialogTitle>
          </DialogHeader>
          {proposal === undefined || field === null ? null : (
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {!hasScopedRationale || proposal.score === undefined ? null : (
                    <Badge variant="outline">{t("Fit {0}%", proposal.score)}</Badge>
                  )}
                  {t("Proposed by {0}", actorName(directory, proposal.author))}
                </p>
                <ProposedValue
                  field={field}
                  proposal={proposal}
                  inputs={view.inputs}
                  criteriaSources={criteriaSources ?? undefined}
                />
                {hasScopedRationale && <ProposalComment key={proposal.id} proposal={proposal} />}
                {error && <ErrorText text={error} />}
              </div>
            </DialogPanel>
          )}
          <DialogFooter className="max-sm:flex-col">
            <Button
              type="button"
              disabled={isBusy || proposal === undefined}
              variant="success"
              onClick={() => review(true)}
            >
              {t("Approve")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isBusy || proposal === undefined}
              onClick={() => review(false)}
            >
              {t("Discard")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isBusy || proposal === undefined}
              onClick={() => {
                if (proposal === undefined) return;
                setPostponed((current) => [...current, proposal.id]);
                if (remaining.length === 1) setIsOpen(false);
              }}
            >
              {t("Maybe (postpone)")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
