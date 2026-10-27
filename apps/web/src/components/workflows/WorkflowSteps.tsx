import type { DraftStep } from "./workflowLogic";
import type { WorkflowDefinitionView } from "@t45/contracts/resources/Workflows";
import { useBlocker } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { api } from "../../rpc/api";
import { Button } from "../ui/button";
import { BackLink, WorkFrame } from "../work/WorkFrame";
import { useWorkflowDefinitionDetail } from "./useWorkflowDefinitionDetail";
import { WorkflowStepEditor } from "./WorkflowStepEditor";
import { blankStep, cleanSteps, listEntries, stepPath, updateStep } from "./workflowLogic";

/** The steps leading to an open sub-step, each a way back to it; the first goes to all steps. */
function StepTrail({
  path,
  onOpen,
}: {
  readonly path: ReadonlyArray<DraftStep>;
  readonly onOpen: (key: string | null) => void;
}) {
  const link = "text-xs text-muted-foreground hover:text-foreground hover:underline";
  return (
    <nav aria-label="Sub-step path" className="flex flex-wrap items-center gap-1">
      <button type="button" className={link} onClick={() => onOpen(null)}>
        All steps
      </button>
      {path.map((step, at) => (
        <span key={step.id} className="flex items-center gap-1">
          <ChevronRightIcon className="size-3 text-muted-foreground" />
          {at === path.length - 1 ? (
            <span className="text-xs font-medium">{step.name || "Untitled sub-step"}</span>
          ) : (
            <button type="button" className={link} onClick={() => onOpen(step.id)}>
              {step.name || "Untitled step"}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Edits a definition's shared steps and fields. A
 * sub-step, at any depth, opens on its own (`openStepKey`), with the trail back. Leaving with
 * unsaved changes asks first; moving between steps here keeps them.
 */
export function WorkflowSteps({
  definitionId,
  openStepKey,
  onOpenStep,
}: {
  readonly definitionId: string;
  readonly openStepKey: string | null;
  readonly onOpenStep: (key: string | null) => void;
}) {
  const [steps, setSteps] = useState<ReadonlyArray<DraftStep>>([]);
  const [dirty, setDirty] = useState(false);
  /** Takes the server's steps as they are, dropping unsaved edits. */
  const adopt = useCallback((loaded: WorkflowDefinitionView) => {
    setSteps(loaded.definition.steps);
    setDirty(false);
  }, []);
  const { detail, busy, error, run } = useWorkflowDefinitionDetail(definitionId, adopt);

  useBlocker({
    // Opening a sub-step stays on this page and keeps the unsaved steps.
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname && !window.confirm("Leave without saving your changes?"),
    disabled: !dirty,
    enableBeforeUnload: dirty,
  });

  if (detail === null) {
    return (
      <WorkFrame title="Steps">
        <p role={error !== null ? "alert" : undefined} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  }

  const { definition, canManage } = detail;
  const disabled = busy || !canManage;
  const edit = (next: ReadonlyArray<DraftStep>) => {
    setSteps(next);
    setDirty(true);
  };
  const addStep = () => edit([...steps, blankStep()]);
  const save = () => {
    void run(() =>
      api("workflows.updateDefinition", {
        definitionId: definition.id,
        steps: cleanSteps(steps),
      }),
    );
  };
  const path = openStepKey === null ? null : stepPath(steps, openStepKey);
  const open = path?.at(-1);

  return (
    <WorkFrame
      title={`${definition.name} · Blueprint steps`}
      back={
        <div className="flex items-center justify-between gap-2">
          <BackLink
            to="/workflow-blueprints/$definitionId"
            params={{ definitionId: definition.id }}
          >
            {definition.name}
          </BackLink>
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {dirty ? "Unsaved changes." : "All changes saved."}
            </span>
            <Button size="sm" disabled={disabled || !dirty} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        These steps and fields are shared by every workflow using this blueprint. Assign people in
        each workflow's settings.
      </p>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Editing requires admin access to every workflow using this blueprint.
        </p>
      ) : null}
      <section aria-label="Step Editor" className="flex flex-col gap-2.5">
        <h2 className="text-sm font-semibold">Step Editor</h2>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {path !== null && open !== undefined ? (
          <div className="flex flex-col gap-2.5">
            <StepTrail path={path} onOpen={onOpenStep} />
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <WorkflowStepEditor
                key={open.id}
                step={open}
                position={null}
                onChange={(next) => edit(updateStep(steps, open.id, () => next))}
                onOpenSubStep={onOpenStep}
                disabled={disabled}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-sm font-medium">Define the steps in this process.</p>
            {steps.length > 0 ? (
              <ol className="flex flex-col gap-2.5">
                {listEntries(steps, edit).map((place) => (
                  <li
                    key={place.entry.id}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <WorkflowStepEditor
                      step={place.entry}
                      position={place}
                      onChange={place.replace}
                      onOpenSubStep={onOpenStep}
                      disabled={disabled}
                    />
                  </li>
                ))}
              </ol>
            ) : null}
            <div>
              <Button size="sm" variant="outline" disabled={disabled} onClick={addStep}>
                <PlusIcon />
                Add step
              </Button>
            </div>
          </div>
        )}
      </section>
    </WorkFrame>
  );
}
