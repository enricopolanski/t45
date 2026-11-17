import { openProposals } from "@t45/contracts/models/Workflow";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { useState } from "react";

import { RecordShowcase } from "../collections/RecordDisplay";
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
}: {
  readonly field: FieldView;
  readonly proposal: Proposal;
}) {
  if (field.type === "records") {
    return field.collection === null || proposal.record === null ? (
      <p className="text-sm text-muted-foreground">The record is gone.</p>
    ) : (
      <RecordShowcase collection={field.collection} record={proposal.record} />
    );
  }
  const { linkUrl: _, ...unlinked } = field;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <ValueBox term="Now" field={field} />
      <ValueBox term="Proposed" field={{ ...unlinked, value: proposal.value }} />
    </dl>
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
  const directory = useWorkDirectory();
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = openProposals(view.proposals);
  const proposal = open[0];
  if (proposal === undefined && !isOpen) return null;
  const field = proposal === undefined ? null : findField(view.fields, proposal.fieldKey);
  const review = (isApproved: boolean) => {
    if (proposal === undefined) return;
    setIsBusy(true);
    setError(null);
    void onReview(proposal, isApproved).then((failure) => {
      setIsBusy(false);
      setError(failure);
      if (failure === null && open.length === 1) setIsOpen(false);
    });
  };
  return (
    <>
      <div>
        <Button type="button" size="sm" onClick={() => setIsOpen(true)}>
          Review ({open.length})
        </Button>
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogPopup aria-label="Review" className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Review {field?.label ?? ""}
              <span className="ms-2 text-sm font-normal text-muted-foreground tabular-nums">
                {open.length} left
              </span>
            </DialogTitle>
          </DialogHeader>
          {proposal === undefined || field === null ? null : (
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {proposal.score === undefined ? null : (
                    <Badge variant="outline">Fit {proposal.score}%</Badge>
                  )}
                  Proposed by {actorName(directory, proposal.author)}
                </p>
                <ProposedValue field={field} proposal={proposal} />
                <div className="grid gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-2">
                  <section aria-label="Why it fits" className="flex flex-col gap-1">
                    <h3 className="text-xs font-medium text-muted-foreground">Why it fits</h3>
                    <p className="whitespace-pre-wrap">{proposal.whyYes}</p>
                  </section>
                  <section aria-label="Why it may not" className="flex flex-col gap-1">
                    <h3 className="text-xs font-medium text-muted-foreground">Why it may not</h3>
                    <p className="whitespace-pre-wrap">{proposal.whyNo || "Nothing against it."}</p>
                  </section>
                </div>
                {error && <ErrorText text={error} />}
              </div>
            </DialogPanel>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isBusy || proposal === undefined}
              onClick={() => review(false)}
            >
              Discard
            </Button>
            <Button
              type="button"
              disabled={isBusy || proposal === undefined}
              onClick={() => review(true)}
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
