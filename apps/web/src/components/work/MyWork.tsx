import type { AssignmentView } from "@t45/contracts/resources/Assignments";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";

import { useMyWork } from "../../state/work";
import { Badge } from "../ui/badge";
import { NewItemDialog } from "./NewItemDialog";
import { WorkFrame } from "./WorkFrame";
import { formatDueDate } from "./workLogic";

/** The signed-in person's work. */
export function MyWorkPage() {
  return (
    <WorkFrame title="My work">
      <MyWork />
    </WorkFrame>
  );
}

/** The steps I have to do; each row opens its step. */
function MyWork() {
  const assignments = useMyWork();

  return (
    <section aria-label="My work" className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">My work</h2>
        <NewItemDialog />
      </div>
      {assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs you right now.</p>
      ) : (
        <ul className="card flex flex-col divide-y divide-border">
          {assignments.map((row) => (
            <li key={row.step.id}>
              <MyWorkRowLink row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MyWorkRowLink({ row }: { readonly row: AssignmentView }) {
  return (
    <Link
      to="/my-work/$stepId"
      params={{ stepId: row.step.id }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.ticket.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[...row.parentNames, row.stepName].join(" › ")} · {row.workflowName}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {row.step.status.type === "blocked" ? <Badge variant="warning">Blocked</Badge> : null}
        <DueBadge dueDate={row.ticket.dueDate} />
      </div>
    </Link>
  );
}

/** A row's due date, red once overdue; nothing without one. */
export function DueBadge({ dueDate }: { readonly dueDate: DateTime.Utc | null }) {
  if (dueDate === null) return null;
  const day = DateTime.formatIso(dueDate).slice(0, 10);
  const isOverdue = day < new Date().toISOString().slice(0, 10);
  return (
    <Badge variant={isOverdue ? "error" : "outline"}>
      {isOverdue ? "Overdue" : "Due"} {formatDueDate(day)}
    </Badge>
  );
}
