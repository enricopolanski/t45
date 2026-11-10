import type { AssignmentView } from "@t45/contracts/resources/Assignments";
import { Link } from "@tanstack/react-router";

import { useMyWork } from "../../state/work";
import { Badge } from "../ui/badge";
import { NewItemDialog } from "./NewItemDialog";
import { WorkFrame } from "./WorkFrame";

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
          {[...row.parentNames, row.stepName].join(" › ")} · {row.projectName}
        </p>
      </div>
      {row.step.status.type === "blocked" ? <Badge variant="warning">Blocked</Badge> : null}
    </Link>
  );
}
