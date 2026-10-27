import type { StepView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FoldChevron } from "./CardFold";
import { ReadOnlyFields } from "./StepFields";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, STEP_STATE_LABELS } from "./workLogic";

/** A row with the step's name, opening to its fields. */
function StepCard({
  name,
  meta,
  children,
}: {
  readonly name: string;
  readonly meta: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <details className="card group">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <FoldChevron />
        <span className="truncate text-sm font-medium">{name}</span>
        {meta}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">{children}</div>
    </details>
  );
}

/** Another step of the item: state, who has it, its fields. */
export function OtherStep({ view }: { readonly view: StepView["otherSteps"][number] }) {
  const directory = useWorkDirectory();
  const { step } = view;
  return (
    <StepCard
      name={view.name}
      meta={
        <>
          <Badge variant="outline">{STEP_STATE_LABELS[step.status.type]}</Badge>
          <span className="truncate text-xs text-muted-foreground">
            {actorName(directory, step.assignee)}
          </span>
        </>
      }
    >
      {view.fields.length > 0 ? (
        <ReadOnlyFields fields={view.fields} />
      ) : (
        <p className="text-sm text-muted-foreground">No fields.</p>
      )}
      <div>
        <Button
          size="xs"
          variant="outline"
          render={<Link to="/my-work/$stepId" params={{ stepId: step.id }} />}
        >
          Open step
        </Button>
      </div>
    </StepCard>
  );
}
