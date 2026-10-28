import type { StepView } from "@t45/contracts/resources/Workflows";
import { CheckIcon, CircleAlertIcon, PauseIcon } from "lucide-react";

import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useWorkDirectory } from "./useWorkDirectory";

/** Latest attempts sit below the automation list and can run again with the latest files. */
export function StepRuns({
  view,
  busy,
  onRun,
  onStop,
}: {
  readonly view: StepView;
  readonly busy: boolean;
  readonly onRun: (automationId: string) => void;
  readonly onStop: (automationId: string) => void;
}) {
  const directory = useWorkDirectory();
  return view.step.automations.map((entry) => {
    const task = view.tasks.findLast((task) => task.trigger.automationId === entry.id);
    if (task === undefined) return null;
    const name = directory.agents.find((agent) => agent.id === entry.agentId)?.name ?? "Agent";
    const execution = task.execution;
    const paused = task.state.type === "active" && view.step.status.type === "blocked";
    const running =
      !paused &&
      (execution === "starting" || execution === "processing" || execution === "waiting");
    const failed = execution === "failed";
    const title = paused
      ? `${name} is paused`
      : {
          starting: `${name} is starting`,
          processing: `${name} is processing this step`,
          waiting: `${name} is waiting`,
          stopped: `${name}: Stopped`,
          finished:
            task.state.type === "settled"
              ? `${name}: Approved`
              : `${name} has finished its contribution`,
          failed: `${name}: Couldn't finish`,
        }[execution];
    const reason =
      task.state.type === "settled" && task.state.outcome.type !== "succeeded"
        ? task.state.outcome.reason
        : null;
    const description =
      reason ??
      (paused
        ? "Work can continue when this step is unblocked."
        : {
            starting: "Preparing the agent and its documents.",
            processing: "Results and any remaining work will appear here when it finishes.",
            waiting: "The agent is waiting to continue.",
            stopped: "Run again to start a fresh attempt with the latest fields and documents.",
            finished:
              view.step.status.type === "waiting_approval"
                ? "The step is ready for approval. You can run again if more documents arrive."
                : "Review the results and finish any remaining work, or run again with more documents.",
            failed: "The run failed. You can start a fresh attempt.",
          }[execution]);
    return (
      <Alert
        key={entry.id}
        variant={failed ? "warning" : "info"}
        icon={
          running ? (
            <Spinner size="md" />
          ) : failed ? (
            <CircleAlertIcon />
          ) : execution === "finished" ? (
            <CheckIcon />
          ) : (
            <PauseIcon />
          )
        }
        title={title}
      >
        <p>{description}</p>
        {view.canRunAutomations ? (
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => onStop(entry.id)}
              >
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onRun(entry.id)}>
                Run again
              </Button>
            )}
          </div>
        ) : null}
      </Alert>
    );
  });
}
