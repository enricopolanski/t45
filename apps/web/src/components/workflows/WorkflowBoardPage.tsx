import type {
  StepSummaryView,
  TicketSummaryView,
  WorkflowInstanceBoardView,
} from "@t45/contracts/resources/Workflows";
import { Link, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { ErrorText } from "../ui/error-text";
import { DueBadge } from "../work/MyWork";
import { NewItemDialog } from "../work/NewItemDialog";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { WorkFrame } from "../work/WorkFrame";
import { actorName, stepStatus } from "../work/workLogic";

function BoardCard({
  ticket,
  step,
}: {
  readonly ticket: TicketSummaryView;
  readonly step: StepSummaryView;
}) {
  const directory = useWorkDirectory();
  const status = stepStatus(step);
  return (
    <Link
      to="/my-work/$stepId"
      params={{ stepId: step.id }}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-muted"
    >
      <span className="text-sm font-medium">{ticket.title}</span>
      <span className="text-xs text-muted-foreground">{actorName(directory, step.assignee)}</span>
      <span className="flex flex-wrap gap-1">
        <Badge variant={status.variant}>{status.label}</Badge>
        <DueBadge dueDate={ticket.dueDate} />
      </span>
    </Link>
  );
}

/**
 * Every open item in its current step's column; a card opens its item, and anyone starts items
 * here unless the workflow is archived. A workflow with a slug is shown under it, so a link by
 * id ends on the slug.
 */
export function WorkflowBoardPage({ workflowId }: { readonly workflowId: string }) {
  const [board, setBoard] = useState<WorkflowInstanceBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("workflows.getInstanceBoard", { idOrSlug: workflowId }).then(
      setBoard,
      (cause: unknown) => setError(describeFailure(cause)),
    );
  }, [workflowId]);

  const slug = board?.workflow.slug ?? null;
  if (slug !== null && slug !== workflowId) {
    return <Navigate to="/boards/$slug" params={{ slug }} replace />;
  }

  return (
    <WorkFrame
      title={board?.workflow.name ?? "Board"}
      width="full"
      actions={
        board !== null && !board.workflow.isArchived ? (
          <NewItemDialog workflow={board.workflow} />
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorText text={error} />}
        <div className="flex gap-3 overflow-x-auto pb-2">
          {board?.definition.steps.map((column) => {
            const cards = board.tickets.flatMap((ticket) =>
              ticket.currentStep?.stepDefinitionId === column.id
                ? [{ ticket, step: ticket.currentStep }]
                : [],
            );
            return (
              <section
                key={column.id}
                aria-label={column.name}
                className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border bg-card p-3"
              >
                <h2 className="text-xs font-medium text-muted-foreground">
                  {column.name} · {cards.length}
                </h2>
                {cards.map((card) => (
                  <BoardCard key={card.ticket.id} ticket={card.ticket} step={card.step} />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </WorkFrame>
  );
}
