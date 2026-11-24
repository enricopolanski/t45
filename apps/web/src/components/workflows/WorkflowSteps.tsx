import { useTranslation } from "~/i18n/locale";
import type { DraftStep } from "./workflowLogic";
import type { WorkflowView } from "@t45/contracts/resources/Workflows";
import { useBlocker } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { api } from "../../rpc/api";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { PageBreadcrumbLink } from "../PageBreadcrumb";
import { WorkFrame } from "../work/WorkFrame";
import { useWorkflowData } from "./useWorkflowData";
import { WorkflowStepEditor } from "./WorkflowStepEditor";
import {
  blankStep,
  cleanSteps,
  editsBetween,
  inputSourcesFor,
  listEntries,
  stepPath,
  updateStep,
} from "./workflowLogic";

/** The steps leading to an open sub-step, each a way back to it; the first goes to all steps. */
function StepTrail({
  path,
  onOpen,
}: {
  readonly path: ReadonlyArray<DraftStep>;
  readonly onOpen: (key: string | null) => void;
}) {
  const t = useTranslation();
  const link = "text-xs text-muted-foreground hover:text-foreground hover:underline";
  return (
    <nav aria-label={t("Sub-step path")} className="flex flex-wrap items-center gap-1">
      <button type="button" className={link} onClick={() => onOpen(null)}>
        {t("All steps")}
      </button>
      {path.map((step, at) => (
        <span key={step.id} className="flex items-center gap-1">
          <ChevronRightIcon className="size-3 text-muted-foreground" />
          {at === path.length - 1 ? (
            <span className="text-xs font-medium">{step.name || t("Untitled sub-step")}</span>
          ) : (
            <button type="button" className={link} onClick={() => onOpen(step.id)}>
              {step.name || t("Untitled step")}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Edits the steps and fields of a workflow's newest version. Saving a draft overwrites it; saving
 * over a version a project adopted starts the next one. A sub-step, at any depth, opens on its own
 * (`openStepKey`), with the trail back. Leaving with unsaved changes asks first; moving between
 * steps here keeps them.
 */
export function WorkflowSteps({
  workflowId,
  openStepKey,
  onOpenStep,
}: {
  readonly workflowId: string;
  readonly openStepKey: string | null;
  readonly onOpenStep: (key: string | null) => void;
}) {
  const t = useTranslation();
  const [steps, setSteps] = useState<ReadonlyArray<DraftStep>>([]);
  const [dirty, setDirty] = useState(false);
  /** Takes the server's steps as they are, dropping unsaved edits. */
  const resetToLoaded = useCallback((loaded: WorkflowView) => {
    setSteps(loaded.version.steps);
    setDirty(false);
  }, []);
  const { detail, busy, error, run } = useWorkflowData(
    useCallback(() => api("workflows.getWorkflow", { workflowId }), [workflowId]),
    resetToLoaded,
  );

  useBlocker({
    // Opening a sub-step stays on this page and keeps the unsaved steps.
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname &&
      !window.confirm(t("Leave without saving your changes?")),
    disabled: !dirty,
    enableBeforeUnload: dirty,
  });

  if (detail === null) {
    return (
      <WorkFrame title={t("Steps")}>
        <p role={error !== null ? "alert" : undefined} className="text-sm text-muted-foreground">
          {error ?? t("Loading…")}
        </p>
      </WorkFrame>
    );
  }

  const { workflow, version, canEdit } = detail;
  const disabled = busy || !canEdit || workflow.isArchived;
  const edit = (next: ReadonlyArray<DraftStep>) => {
    setSteps(next);
    setDirty(true);
  };
  const addStep = () => edit([...steps, blankStep()]);
  const save = () => {
    void run(() =>
      api("workflows.saveWorkflowDraft", {
        versionId: version.id,
        revision: version.revision,
        edits: editsBetween(version.steps, cleanSteps(steps)),
      }),
    );
  };
  const path = openStepKey === null ? null : stepPath(steps, openStepKey);
  const open = path?.at(-1);

  return (
    <WorkFrame
      title={t("Steps")}
      tabTitle={t("Steps · {0}", workflow.name)}
      parent={
        <PageBreadcrumbLink
          to="/settings/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
        >
          {workflow.name}
        </PageBreadcrumbLink>
      }
      actions={
        <>
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {dirty ? t("Unsaved changes.") : t("All changes saved.")}
          </span>
          <Button size="sm" disabled={disabled || !dirty} onClick={save}>
            {t("Save")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {version.isFrozen
          ? t(
              "Version {0} is in use and no longer changes: saving starts version {1}. Layouts are the exception: every version takes them in place. ",
              version.number,
              version.number + 1,
            )
          : t("Version {0} is a draft until a project adopts it. ", version.number)}
        {t("Tickets keep the version they started on.")}
      </p>
      {!canEdit ? (
        <p className="text-sm text-muted-foreground">
          {t("Only this workflow's creator, its editors and organization admins can edit it.")}
        </p>
      ) : null}
      <section aria-label={t("Step Editor")} className="flex flex-col gap-2.5">
        <h2 className="text-sm font-semibold">{t("Step Editor")}</h2>
        {error && <ErrorText text={error} />}
        {path !== null && open !== undefined ? (
          <div className="flex flex-col gap-2.5">
            <StepTrail path={path} onOpen={onOpenStep} />
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <WorkflowStepEditor
                key={open.id}
                workflow={workflow}
                step={open}
                inputSources={inputSourcesFor(steps, open.id)}
                calculators={detail.calculators}
                position={null}
                onChange={(next) => edit(updateStep(steps, open.id, () => next))}
                onOpenSubStep={onOpenStep}
                disabled={disabled}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-sm font-medium">{t("Define the steps in this process.")}</p>
            {steps.length > 0 ? (
              <ol className="flex flex-col gap-2.5">
                {listEntries(steps, edit).map((place) => (
                  <li
                    key={place.entry.id}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <WorkflowStepEditor
                      workflow={workflow}
                      step={place.entry}
                      inputSources={inputSourcesFor(steps, place.entry.id)}
                      calculators={detail.calculators}
                      precedingStepId={steps[place.index - 1]?.id}
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
                {t("Add step")}
              </Button>
            </div>
          </div>
        )}
      </section>
    </WorkFrame>
  );
}
