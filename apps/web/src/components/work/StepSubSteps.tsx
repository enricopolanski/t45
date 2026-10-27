import type { StepView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";

import { Badge } from "../ui/badge";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, STEP_STATE_LABELS } from "./workLogic";

/**
 * The step's sub-steps, each opening as a step of its own; the step can't be marked done until
 * every one is approved. Shown only when the step has sub-steps.
 */
export function StepSubSteps({ view }: { readonly view: StepView }) {
  const directory = useWorkDirectory();
  if (view.subSteps.length === 0) return null;
  return (
    <section aria-label="Sub-steps" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Sub-steps</h2>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        {view.subSteps.map((subStep) => {
          const step = view.ticket.steps.find((candidate) => candidate.id === subStep.id);
          return (
            <div key={subStep.id} className="flex items-center gap-3">
              <Link
                to="/my-work/$stepId"
                params={{ stepId: subStep.id }}
                className="min-w-0 flex-1 hover:underline"
              >
                <p
                  className={
                    step?.status.type === "completed"
                      ? "truncate text-sm text-muted-foreground line-through"
                      : "truncate text-sm"
                  }
                >
                  {subStep.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {actorName(directory, step?.assignee ?? null)}
                </p>
              </Link>
              {step ? <Badge variant="outline">{STEP_STATE_LABELS[step.status.type]}</Badge> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
