import type { WorkflowView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useId, useRef, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { WorkFrame } from "../work/WorkFrame";
import { plural } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import { useWorkflowData } from "./useWorkflowData";
import { WorkflowNavigation } from "./WorkflowNavigation";

const loadWorkflows = () => api("workflows.listWorkflows", undefined);

export function WorkflowList() {
  const { detail: workflows, error } = useWorkflowData(loadWorkflows);
  return (
    <WorkFrame
      title="Workflows"
      actions={
        <>
          <WorkflowNavigation />
          <Button size="sm" render={<Link to="/settings/workflows/new" />}>
            New workflow
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Workflows define the process: steps, fields and rules. Create projects from them to assign
        people and run tickets.
      </p>
      {error && <ErrorText text={error} />}
      {workflows?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workflows yet. Create a workflow to get started.
        </p>
      ) : null}
      <section aria-label="Workflows" className="flex flex-col gap-3">
        {workflows?.map((workflow) => (
          <div
            key={workflow.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{workflow.name}</p>
              <p className="text-xs text-muted-foreground">
                {plural(workflow.steps.length, "step", "steps")}
              </p>
            </div>
            {workflow.isArchived ? (
              <Badge variant="secondary">Archived</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/settings/projects/new" search={{ workflowId: workflow.id }} />}
              >
                Create project
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              render={
                <Link to="/settings/workflows/$workflowId" params={{ workflowId: workflow.id }} />
              }
            >
              Open workflow
            </Button>
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}

export function NewWorkflow() {
  const id = useId();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  return (
    <WorkFrame title="New workflow">
      <p className="text-sm text-muted-foreground">
        Define the process once. Each project using it will have its own people and assignments.
      </p>
      <form
        aria-label="New workflow"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError(null);
          void api("workflows.createWorkflow", { name: name.trim() }).then(
            ({ workflowId }) =>
              void navigate({
                to: "/settings/workflows/$workflowId/steps",
                params: { workflowId },
              }),
            (cause: unknown) => {
              inFlight.current = false;
              setBusy(false);
              setError(describeFailure(cause));
            },
          );
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Workflow name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            placeholder="Hiring process"
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>
        {error && <ErrorText text={error} />}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create workflow
          </Button>
        </div>
      </form>
    </WorkFrame>
  );
}

export function WorkflowEditor({ workflowId }: { readonly workflowId: string }) {
  const id = useId();
  const [name, setName] = useState("");
  const adopt = useCallback((loaded: WorkflowView) => setName(loaded.workflow.name), []);
  const { detail, busy, error, run } = useWorkflowData(
    useCallback(() => api("workflows.getWorkflow", { workflowId }), [workflowId]),
    adopt,
  );
  if (detail === null)
    return (
      <WorkFrame title="Workflow">
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  const { workflow, canManage } = detail;
  return (
    <WorkFrame
      title={workflow.name}
      actions={
        !workflow.isArchived ? (
          <Button size="sm" render={<Link to="/settings/projects/new" search={{ workflowId }} />}>
            Create project
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        This is a shared workflow. Changes to its steps and fields apply to every project using it.
        People are assigned separately in each project.
      </p>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Editing requires admin access to every project using this workflow.
        </p>
      ) : null}
      {error && <ErrorText text={error} />}
      <section
        aria-label="Workflow"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Workflow name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy || !canManage}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (name.trim() && name.trim() !== workflow.name)
                void run(() => api("workflows.updateWorkflow", { workflowId, name: name.trim() }));
            }}
          />
        </div>
        <ActionRow
          title={plural(workflow.steps.length, "step", "steps")}
          action={
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/workflows/$workflowId/steps" params={{ workflowId }} />}
            >
              {canManage ? "Edit steps" : "View steps"}
            </Button>
          }
        />
      </section>
      <section
        aria-label="Workflow availability"
        className="rounded-xl border border-border bg-card"
      >
        <ActionRow
          title={!workflow.isArchived ? "Archive workflow" : "Archived workflow"}
          description="Archived workflows cannot be used to create new projects. Existing projects keep running."
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canManage}
              onClick={() =>
                void run(() =>
                  api("workflows.updateWorkflow", {
                    workflowId,
                    isArchived: !workflow.isArchived,
                  }),
                )
              }
            >
              {!workflow.isArchived ? "Archive workflow" : "Restore workflow"}
            </Button>
          }
        />
      </section>
    </WorkFrame>
  );
}
