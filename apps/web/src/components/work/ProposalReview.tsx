import { useTranslation } from "~/i18n/locale";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import {
  evaluateProposalFilterCascade,
  openProposals,
  type ProposalFilterDraftAnswer,
} from "@t45/contracts/models/Workflow";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { formatRecordValue } from "../collections/Records";
import { MarkdownText } from "../markdown/MarkdownText";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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

const proposalLabel = (field: FieldView | null, proposal: Proposal): string => {
  if (field?.type === "records" && field.collection !== null && proposal.record !== null) {
    const title = resolveRecordDisplay(field.collection).title;
    if (title !== undefined) {
      const formatted = formatRecordValue(
        title,
        proposal.record.values[title.id],
        proposal.record.files,
      );
      if (formatted) return formatted;
    }
    return proposal.record.key;
  }
  return typeof proposal.value === "string" ? proposal.value : JSON.stringify(proposal.value);
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
 * The open proposals of a step, starting with any saved discrepancy-filter cascade before
 * individual review, best first. At the end of the cascade, the reviewer can approve surviving
 * candidates and discard excluded ones in one step, or inspect remaining candidates individually.
 */
export function ProposalReview({
  view,
  onReview,
  onReviewMany,
}: {
  readonly view: StepView;
  readonly onReview: (proposal: Proposal, isApproved: boolean) => Promise<string | null>;
  readonly onReviewMany: (
    fieldKey: string,
    decisions: {
      readonly approveIds: ReadonlyArray<string>;
      readonly discardIds: ReadonlyArray<string>;
    },
  ) => Promise<string | null>;
}) {
  const t = useTranslation();
  const directory = useWorkDirectory();
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postponed, setPostponed] = useState<ReadonlyArray<string>>([]);
  const [mode, setMode] = useState<"cascade" | "individual">("individual");
  const [draftAnswers, setDraftAnswers] = useState<
    Readonly<Record<string, ProposalFilterDraftAnswer>>
  >({});
  const [uncheckedByFilter, setUncheckedByFilter] = useState<
    Readonly<Record<string, ReadonlyArray<string>>>
  >({});
  const [uncheckedApprovals, setUncheckedApprovals] = useState<ReadonlyArray<string>>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [isConfirming, setIsConfirming] = useState(false);

  const open = openProposals(view.proposals);
  const remaining = open.filter((candidate) => !postponed.includes(candidate.id));
  const savedFilters = view.step.proposalFilters ?? [];
  const cascadeFieldKey =
    remaining.find((candidate) =>
      savedFilters.some(
        (filter) =>
          filter.fieldKey === candidate.fieldKey &&
          filter.items.some((item) => item.proposalId === candidate.id),
      ),
    )?.fieldKey ?? null;
  const cascadeField = cascadeFieldKey === null ? null : findField(view.fields, cascadeFieldKey);
  const cascadeOpen =
    cascadeFieldKey === null
      ? []
      : remaining.filter((candidate) => candidate.fieldKey === cascadeFieldKey);
  const cascadeFilters =
    cascadeFieldKey === null
      ? []
      : savedFilters.filter((filter) => filter.fieldKey === cascadeFieldKey);
  const cascade = evaluateProposalFilterCascade(cascadeOpen, cascadeFilters, draftAnswers);
  const isCascadeMode = mode === "cascade" && cascadeField !== null && cascade.steps.length > 0;

  const proposal = remaining[0];
  if (open.length === 0 && !isOpen) return null;
  const field = isCascadeMode
    ? cascadeField
    : proposal === undefined
      ? null
      : findField(view.fields, proposal.fieldKey);
  const criteriaSources = field && view.comparisonSources?.[field.key];
  const hasScopedRationale = !criteriaSources || proposal?.comparison !== undefined;

  const proposalById = new Map(cascadeOpen.map((item) => [item.id, item]));
  const safeIndex = Math.min(stepIndex, Math.max(0, cascade.steps.length - 1));
  const currentStep = isCascadeMode ? cascade.steps[safeIndex] : undefined;
  const currentLiveIds = currentStep?.liveItems.map((item) => item.proposalId) ?? [];
  const currentUnchecked =
    currentStep === undefined ? [] : (uncheckedByFilter[currentStep.filter.id] ?? []);
  const currentCheckedIds = currentLiveIds.filter((id) => !currentUnchecked.includes(id));

  const canBulkApprove = cascadeField?.type === "records" || cascade.inPlayIds.length <= 1;
  const checkedApproveIds = canBulkApprove
    ? cascade.inPlayIds.filter((id) => !uncheckedApprovals.includes(id))
    : [];

  const openDialog = () => {
    setPostponed([]);
    setDraftAnswers({});
    setUncheckedByFilter({});
    setUncheckedApprovals([]);
    setStepIndex(0);
    setIsConfirming(false);
    setError(null);
    const hasFilters = open.some((candidate) =>
      savedFilters.some(
        (filter) =>
          filter.fieldKey === candidate.fieldKey &&
          filter.items.some((item) => item.proposalId === candidate.id),
      ),
    );
    setMode(hasFilters ? "cascade" : "individual");
    setIsOpen(true);
  };

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

  const toggleItemChecked = (filterId: string, proposalId: string, isChecked: boolean) => {
    setUncheckedByFilter((current) => {
      const existing = current[filterId] ?? [];
      const next = isChecked
        ? existing.filter((id) => id !== proposalId)
        : existing.includes(proposalId)
          ? existing
          : [...existing, proposalId];
      return { ...current, [filterId]: next };
    });
  };

  const toggleApprovalChecked = (proposalId: string, isChecked: boolean) => {
    setUncheckedApprovals((current) =>
      isChecked
        ? current.filter((id) => id !== proposalId)
        : current.includes(proposalId)
          ? current
          : [...current, proposalId],
    );
  };

  const answerFilter = (decision: "accept" | "exclude") => {
    if (currentStep === undefined) return;
    const nextAnswer: ProposalFilterDraftAnswer = {
      decision,
      shownIds: currentLiveIds,
      excludedIds: decision === "exclude" ? currentCheckedIds : [],
    };
    const nextDrafts = { ...draftAnswers, [currentStep.filter.id]: nextAnswer };
    setDraftAnswers(nextDrafts);
    setError(null);
    const next = evaluateProposalFilterCascade(cascadeOpen, cascadeFilters, nextDrafts);
    const currentPos = next.steps.findIndex((step) => step.filter.id === currentStep.filter.id);
    const nextAfter = next.steps.findIndex(
      (step, index) => index > currentPos && step.answer === null,
    );
    if (nextAfter >= 0) {
      setStepIndex(nextAfter);
      setIsConfirming(false);
      return;
    }
    if (next.nextUnansweredIndex >= 0) {
      setStepIndex(next.nextUnansweredIndex);
      setIsConfirming(false);
      return;
    }
    setIsConfirming(true);
  };

  const switchToIndividual = () => {
    setError(null);
    if (cascade.excludedIds.length === 0) {
      setIsConfirming(false);
      setMode("individual");
      return;
    }
    setIsConfirming(true);
  };

  const applyBatch = (approveIds: ReadonlyArray<string>, discardIds: ReadonlyArray<string>) => {
    if (cascadeFieldKey === null || (approveIds.length === 0 && discardIds.length === 0)) {
      setIsConfirming(false);
      setMode("individual");
      return;
    }
    const resolvedCount = approveIds.length + discardIds.length;
    setIsBusy(true);
    setError(null);
    void onReviewMany(cascadeFieldKey, { approveIds, discardIds }).then((failure) => {
      setIsBusy(false);
      setError(failure);
      if (failure !== null) return;
      setDraftAnswers({});
      setUncheckedByFilter({});
      setUncheckedApprovals([]);
      setStepIndex(0);
      setIsConfirming(false);
      setMode("individual");
      if (remaining.length <= resolvedCount) setIsOpen(false);
    });
  };

  const excludedReasonsById = new Map<string, Array<string>>();
  for (const step of cascade.steps) {
    if (step.answer?.decision !== "exclude") continue;
    for (const id of step.answer.excludedIds) {
      const reasons = excludedReasonsById.get(id) ?? [];
      const item = step.liveItems.find((entry) => entry.proposalId === id);
      if (item !== undefined) reasons.push(item.reason);
      excludedReasonsById.set(id, reasons);
    }
  }

  const viewKey = isCascadeMode
    ? isConfirming
      ? "cascade-confirm"
      : `cascade-question-${currentStep?.filter.id ?? "none"}`
    : `individual-${proposal?.id ?? "empty"}`;

  return (
    <>
      <div>
        <Button type="button" size="sm" onClick={openDialog}>
          {t("Review ({0})", open.length)}
        </Button>
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogPopup
          aria-label={t("Review")}
          className={field?.type === "records" ? "sm:max-w-7xl" : "sm:max-w-3xl"}
        >
          <DialogHeader>
            <div className="flex flex-wrap items-center justify-between gap-2 pe-8">
              <DialogTitle>
                <span>{field === null ? t("Review") : t("Review {0}", field.label)}</span>
                <span
                  key={viewKey}
                  className="ms-2 text-sm font-normal text-muted-foreground tabular-nums"
                >
                  {isCascadeMode
                    ? isConfirming
                      ? t(
                          "{0} to approve · {1} to discard",
                          checkedApproveIds.length,
                          cascade.excludedIds.length,
                        )
                      : `${t("Question {0} of {1}", safeIndex + 1, cascade.steps.length)} · ${t("{0} in play", cascade.inPlayIds.length)}`
                    : `${t("{0} left", remaining.length)}${postponed.length > 0 ? t(" · {0} postponed", postponed.length) : ""}`}
                </span>
              </DialogTitle>
              {view.preview && (
                <Link
                  to="/my-work/preview/$ticketId/$stepDefinitionId"
                  params={{
                    ticketId: view.preview.ticketId,
                    stepDefinitionId: view.preview.stepDefinitionId,
                  }}
                  target="_blank"
                  rel="noopener"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t("Preliminary results")}
                </Link>
              )}
              {isCascadeMode && !isConfirming ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={isBusy}
                  onClick={switchToIndividual}
                >
                  {t("Individual review")}
                </Button>
              ) : null}
            </div>
          </DialogHeader>
          <div key={viewKey} className="flex min-h-0 flex-1 flex-col">
            {isCascadeMode ? (
              isConfirming ? (
                <>
                  <DialogPanel>
                    <div className="flex flex-col gap-5">
                      <h3 className="text-base font-semibold">{t("Review summary")}</h3>
                      {canBulkApprove && cascade.inPlayIds.length > 0 ? (
                        <section className="flex flex-col gap-2">
                          <h4 className="text-sm font-semibold">
                            {t("To approve ({0})", checkedApproveIds.length)}
                          </h4>
                          <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full border-collapse text-left text-sm">
                              <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
                                <tr>
                                  <th scope="col" className="w-10 px-3 py-2">
                                    <span className="sr-only">{t("Approve")}</span>
                                  </th>
                                  <th scope="col" className="px-3 py-2 font-medium">
                                    {t("Candidate")}
                                  </th>
                                  <th scope="col" className="px-3 py-2 font-medium">
                                    {t("Why it fits")}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {cascade.inPlayIds.map((id) => {
                                  const entry = proposalById.get(id);
                                  if (entry === undefined) return null;
                                  const label = proposalLabel(cascadeField, entry);
                                  const isChecked = !uncheckedApprovals.includes(id);
                                  return (
                                    <tr key={id} className="border-b last:border-b-0 align-top">
                                      <td className="px-3 py-2.5">
                                        <Checkbox
                                          checked={isChecked}
                                          aria-label={t("Include {0} in approval", label)}
                                          onCheckedChange={(checked) =>
                                            toggleApprovalChecked(id, checked === true)
                                          }
                                        />
                                      </td>
                                      <td className="px-3 py-2.5">
                                        <div className="flex flex-wrap items-center gap-2 font-medium">
                                          <span>{label}</span>
                                          {entry.score === undefined ? null : (
                                            <Badge variant="outline">
                                              {t("Fit {0}%", entry.score)}
                                            </Badge>
                                          )}
                                        </div>
                                        {typeof entry.value === "string" &&
                                        entry.value !== label ? (
                                          <div className="text-xs text-muted-foreground">
                                            {entry.value}
                                          </div>
                                        ) : null}
                                      </td>
                                      <td className="px-3 py-2.5">
                                        <div>{entry.whyYes}</div>
                                        {entry.whyNo ? (
                                          <p className="mt-1 text-xs text-muted-foreground">
                                            {entry.whyNo}
                                          </p>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ) : null}
                      {cascade.excludedIds.length > 0 ? (
                        <section className="flex flex-col gap-2">
                          <h4 className="text-sm font-semibold">
                            {t("To discard ({0})", cascade.excludedIds.length)}
                          </h4>
                          <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full border-collapse text-left text-sm">
                              <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
                                <tr>
                                  <th scope="col" className="px-4 py-2 font-medium">
                                    {t("Candidate")}
                                  </th>
                                  <th scope="col" className="px-4 py-2 font-medium">
                                    {t("Reason")}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {cascade.excludedIds.map((id) => {
                                  const entry = proposalById.get(id);
                                  if (entry === undefined) return null;
                                  return (
                                    <tr key={id} className="border-b last:border-b-0 align-top">
                                      <td className="px-4 py-2.5 font-medium">
                                        <div>{proposalLabel(cascadeField, entry)}</div>
                                        {typeof entry.value === "string" ? (
                                          <div className="text-xs text-muted-foreground">
                                            {entry.value}
                                          </div>
                                        ) : null}
                                      </td>
                                      <td className="px-4 py-2.5 text-muted-foreground">
                                        {(excludedReasonsById.get(id) ?? []).join(" · ")}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ) : null}
                      {error && <ErrorText text={error} />}
                    </div>
                  </DialogPanel>
                  <DialogFooter className="max-sm:flex-col">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => {
                        setIsConfirming(false);
                        setStepIndex(Math.max(0, cascade.steps.length - 1));
                      }}
                    >
                      {t("Back")}
                    </Button>
                    {cascade.excludedIds.length > 0 && checkedApproveIds.length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() => applyBatch([], cascade.excludedIds)}
                      >
                        {t("Discard {0} only", cascade.excludedIds.length)}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() => {
                          setIsConfirming(false);
                          setMode("individual");
                        }}
                      >
                        {t("Individual review")}
                      </Button>
                    )}
                    {checkedApproveIds.length > 0 ? (
                      <Button
                        type="button"
                        variant="success"
                        disabled={isBusy}
                        onClick={() => applyBatch(checkedApproveIds, cascade.excludedIds)}
                      >
                        {cascade.excludedIds.length > 0
                          ? t(
                              "Approve {0} & discard {1}",
                              checkedApproveIds.length,
                              cascade.excludedIds.length,
                            )
                          : t("Approve {0}", checkedApproveIds.length)}
                      </Button>
                    ) : cascade.excludedIds.length > 0 ? (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={isBusy}
                        onClick={() => applyBatch([], cascade.excludedIds)}
                      >
                        {t("Discard {0}", cascade.excludedIds.length)}
                      </Button>
                    ) : null}
                  </DialogFooter>
                </>
              ) : currentStep === undefined ? null : (
                <>
                  <DialogPanel>
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {t("{0} affected", currentStep.liveItems.length)}
                          </Badge>
                          {currentStep.isInvalidated ? (
                            <Badge variant="warning">
                              {t("Affected items changed — please review again.")}
                            </Badge>
                          ) : null}
                        </div>
                        <h3 className="text-base font-semibold">{currentStep.filter.question}</h3>
                        <p className="text-sm text-muted-foreground">
                          {currentStep.filter.driftSummary}
                        </p>
                      </div>
                      <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
                            <tr>
                              <th scope="col" className="w-10 px-3 py-2">
                                <span className="sr-only">{t("Exclude {0}", "")}</span>
                              </th>
                              <th scope="col" className="px-3 py-2 font-medium">
                                {t("Candidate")}
                              </th>
                              <th scope="col" className="px-3 py-2 font-medium">
                                {t("Discrepancy")}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentStep.liveItems.map((item) => {
                              const entry = proposalById.get(item.proposalId);
                              if (entry === undefined) return null;
                              const label = proposalLabel(cascadeField, entry);
                              const isChecked = !currentUnchecked.includes(item.proposalId);
                              return (
                                <tr
                                  key={item.proposalId}
                                  className="border-b last:border-b-0 align-top"
                                >
                                  <td className="px-3 py-2.5">
                                    <Checkbox
                                      checked={isChecked}
                                      aria-label={t("Include {0} in exclusion", label)}
                                      onCheckedChange={(checked) =>
                                        toggleItemChecked(
                                          currentStep.filter.id,
                                          item.proposalId,
                                          checked === true,
                                        )
                                      }
                                    />
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <div className="flex flex-wrap items-center gap-2 font-medium">
                                      <span>{label}</span>
                                      {entry.score === undefined ? null : (
                                        <Badge variant="outline">
                                          {t("Fit {0}%", entry.score)}
                                        </Badge>
                                      )}
                                    </div>
                                    {typeof entry.value === "string" && entry.value !== label ? (
                                      <div className="text-xs text-muted-foreground">
                                        {entry.value}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <div>{item.reason}</div>
                                    {entry.whyNo && entry.whyNo !== item.reason ? (
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        {entry.whyNo}
                                      </p>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {error && <ErrorText text={error} />}
                    </div>
                  </DialogPanel>
                  <DialogFooter className="max-sm:flex-col">
                    {safeIndex > 0 ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => setStepIndex(safeIndex - 1)}
                      >
                        {t("Back")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => answerFilter("accept")}
                    >
                      {t("Accept this discrepancy")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isBusy || currentCheckedIds.length === 0}
                      onClick={() => answerFilter("exclude")}
                    >
                      {t("Exclude {0}", currentCheckedIds.length)}
                    </Button>
                  </DialogFooter>
                </>
              )
            ) : (
              <>
                {proposal === undefined || field === null ? null : (
                  <DialogPanel>
                    <div className="flex flex-col gap-4">
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {!hasScopedRationale || proposal.score === undefined ? null : (
                          <Badge variant="outline">{t("Fit {0}%", proposal.score)}</Badge>
                        )}
                        <span>{t("Proposed by {0}", actorName(directory, proposal.author))}</span>
                      </p>
                      <ProposedValue
                        field={field}
                        proposal={proposal}
                        inputs={view.inputs}
                        criteriaSources={criteriaSources ?? undefined}
                      />
                      {hasScopedRationale && (
                        <ProposalComment key={proposal.id} proposal={proposal} />
                      )}
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
              </>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
