import { chatTargets } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { useNewChat } from "../../hooks/useNewChat";
import { toastFailure } from "../../state/query";
import { Button } from "../ui/button";
import type {
  StepSummaryView,
  TicketSummaryView,
  ProjectBoardView,
} from "@t45/contracts/resources/Workflows";
import { Link, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { ErrorText } from "../ui/error-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
      </span>
    </Link>
  );
}

/**
 * The open items of one version of the project's workflow, each in its current step's column: the
 * adopted version, or an older one chosen while it still has open items. The viewer gets the
 * columns of the steps they are a member of. A card opens its item, and the first step's members
 * start items here. A project with a slug is shown under it, so a link by id ends on the slug.
 */
export function ProjectBoardPage({ projectId }: { readonly projectId: string }) {
  const newChat = useNewChat();
  const targets = useApiQuery(chatTargets);
  const [board, setBoard] = useState<ProjectBoardView | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("workflows.getProjectBoard", {
      idOrSlug: projectId,
      ...(versionId === null ? {} : { versionId }),
    }).then(setBoard, (cause: unknown) => setError(describeFailure(cause)));
  }, [projectId, versionId]);

  const slug = board?.project.slug ?? null;
  const target = targets.data?.find((target) => target.projectId === board?.project.id);
  if (slug !== null && slug !== projectId) {
    return <Navigate to="/boards/$slug" params={{ slug }} replace />;
  }

  return (
    <WorkFrame
      title={board?.project.name ?? "Board"}
      width="full"
      actions={
        board !== null ? (
          <>
            {board.versions.length > 1 ? (
              <Select
                value={board.version.id}
                onValueChange={setVersionId}
                items={board.versions.map(({ id, number }) => ({
                  value: id,
                  label: `Version ${number}`,
                }))}
              >
                <SelectTrigger size="sm" aria-label="Workflow version">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {board.versions.map(({ id, number }) => (
                    <SelectItem key={id} value={id}>
                      Version {number}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {target !== undefined && !board.project.isArchived && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void newChat(target.agentId, target.projectId).catch((cause) =>
                    toastFailure("Project chat unavailable", cause),
                  )
                }
              >
                Chat
              </Button>
            )}
            {board.canStartTicket && <NewItemDialog project={board.project} />}
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorText text={error} />}
        <div className="flex gap-3 overflow-x-auto pb-2">
          {board?.columns.map((column) => {
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
