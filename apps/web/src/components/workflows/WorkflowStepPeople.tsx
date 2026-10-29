import type { StepAutomation, StepDefinition, Workflow } from "@t45/contracts/models/Workflow";
import type { WorkflowInstanceView } from "@t45/contracts/resources/Workflows";
import { useState } from "react";

import { api } from "../../rpc/api";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PersonPicker } from "../work/ActorPicker";
import { FoldChevron } from "../work/CardFold";
import { StepAutomationsEditor } from "../work/StepAutomationsEditor";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { actorName, plural } from "../work/workLogic";
import type { useWorkflowDetail } from "./useWorkflowDetail";

type Assignment = Workflow["defaultAssignments"][string];

const EMPTY_AUTOMATIONS: ReadonlyArray<StepAutomation> = [];
const EMPTY_ASSIGNMENT = { assignee: null, responsible: null, automations: EMPTY_AUTOMATIONS };

/** Parent assignments stay visible above their sub-steps, which can override the defaults. */
function StepPeopleCard({
  step,
  position,
  parentName,
  workflow,
  busy,
  onSave,
}: {
  readonly step: StepDefinition;
  readonly position: number;
  readonly parentName: string | null;
  readonly workflow: Workflow;
  readonly busy: boolean;
  readonly onSave: (stepId: string, change: Partial<Assignment>) => Promise<boolean>;
}) {
  const directory = useWorkDirectory();
  const [opened, setOpened] = useState(false);
  const assignment = workflow.defaultAssignments[step.id] ?? EMPTY_ASSIGNMENT;
  const name = parentName === null ? step.name : `${parentName} › ${step.name}`;
  const unassigned =
    parentName !== null
      ? "Same as parent step"
      : position === 1
        ? "Unassigned"
        : "Same as previous step";
  const summary = [
    `Assignee: ${assignment.assignee === null ? unassigned : actorName(directory, assignment.assignee)}`,
    `Responsible: ${actorName(directory, assignment.responsible ?? workflow.responsible)}`,
    ...(assignment.automations.length > 0
      ? [plural(assignment.automations.length, "automation", "automations")]
      : []),
    ...(step.subSteps.length > 0 ? [plural(step.subSteps.length, "sub-step", "sub-steps")] : []),
  ].join(" · ");

  return (
    <section aria-label={`${name} assignments`} className="rounded-xl border border-border bg-card">
      <Collapsible onOpenChange={(open) => open && setOpened(true)}>
        <CollapsibleTrigger
          aria-label={`Configure ${name}`}
          className="group flex w-full items-start gap-2.5 px-4 py-3.5 text-left"
        >
          <span className="pt-0.5">
            <FoldChevron />
          </span>
          <span className="pt-0.5 font-mono text-xs text-muted-foreground">{position}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm font-medium">{step.name}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">{summary}</span>
          </span>
        </CollapsibleTrigger>
        {/* Folding an opened card keeps unsaved automation edits. Closed cards load on demand. */}
        <CollapsiblePanel keepMounted={opened}>
          <div className="flex flex-col gap-4 border-t border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Assignee</span>
                <PersonPicker
                  aria-label={`${name} assignee`}
                  value={assignment.assignee}
                  onChange={(assignee) => void onSave(step.id, { assignee })}
                  noneLabel={unassigned}
                  onClear={() => void onSave(step.id, { assignee: null })}
                  placeholder="Choose an assignee"
                  disabled={busy}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Responsible</span>
                <PersonPicker
                  aria-label={`${name} responsible`}
                  value={assignment.responsible}
                  onChange={(responsible) => void onSave(step.id, { responsible })}
                  noneLabel="The workflow's responsible"
                  onClear={() => void onSave(step.id, { responsible: null })}
                  placeholder="Choose who approves"
                  disabled={busy}
                />
              </div>
            </div>
            <StepAutomationsEditor
              entries={assignment.automations}
              busy={busy}
              onSave={(automations) => onSave(step.id, { automations })}
            />
            {step.subSteps.length > 0 ? (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground">Sub-steps</p>
                {step.subSteps.map((child, index) => (
                  <StepPeopleCard
                    key={child.id}
                    step={child}
                    position={index + 1}
                    parentName={name}
                    workflow={workflow}
                    busy={busy}
                    onSave={onSave}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function WorkflowStepPeople({
  detail,
  busy,
  run,
}: {
  readonly detail: WorkflowInstanceView;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useWorkflowDetail>["run"];
}) {
  const { workflow, definition } = detail;
  const save = (stepId: string, change: Partial<Assignment>) => {
    const current = workflow.defaultAssignments[stepId] ?? EMPTY_ASSIGNMENT;
    const next = { ...current, ...change };
    const others = Object.fromEntries(
      Object.entries(workflow.defaultAssignments).filter(([id]) => id !== stepId),
    );
    const defaultAssignments =
      next.assignee === null && next.responsible === null && next.automations.length === 0
        ? others
        : { ...others, [stepId]: next };
    return run(() =>
      api("workflows.updateInstance", { workflowId: workflow.id, defaultAssignments }),
    );
  };
  return (
    <section aria-label="Who does each step" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Who does each step</h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Tickets can start unassigned. Sub-steps inherit their parent's assignee; later main steps
        inherit the previous step's assignee. Open a card to choose someone else or add automations.
      </p>
      {definition.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No steps yet.</p>
      ) : null}
      <div className="flex flex-col gap-4">
        {definition.steps.map((step, index) => (
          <StepPeopleCard
            key={step.id}
            step={step}
            position={index + 1}
            parentName={null}
            workflow={workflow}
            busy={busy}
            onSave={save}
          />
        ))}
      </div>
    </section>
  );
}
