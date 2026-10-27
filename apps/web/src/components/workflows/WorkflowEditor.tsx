import { toSlug } from "@t45/contracts/models/Workflow";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { api, type ApiInput } from "../../rpc/api";
import { SavedInput } from "../SavedInput";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { WorkFrame } from "../work/WorkFrame";
import { plural } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import { useWorkflowDetail } from "./useWorkflowDetail";
import { WorkflowDangerZone, WorkflowPeople, WorkflowStepPeople } from "./WorkflowPeople";

/**
 * A workflow as its admins shape it, in cards: its name first, a link to the step editor, its
 * people, and archiving or deleting it last. Everything here applies at once; steps are saved
 * on their own page.
 */
export function WorkflowEditor({ workflowId }: { readonly workflowId: string }) {
  const id = useId();
  const { detail, busy, error, run } = useWorkflowDetail(workflowId);

  if (detail === null) {
    return (
      <WorkFrame title="Workflow">
        <p role={error !== null ? "alert" : undefined} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  }

  const { workflow, definition } = detail;
  const steps = detail.definition.steps.length;
  const update = (change: Omit<ApiInput<"workflows.updateInstance">, "workflowId">) =>
    run(() => api("workflows.updateInstance", { workflowId: workflow.id, ...change }));

  return (
    <WorkFrame
      title={workflow.name}
      actions={
        steps > 0 ? (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/boards/$slug" params={{ slug: workflow.id }} />}
          >
            Board
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        This workflow uses the {definition.name} blueprint. Its name, people and assignments belong
        to this workflow.
      </p>
      <div className="flex flex-col gap-6">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <section aria-label="General" className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">General</h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <p className="text-xs text-muted-foreground">How this process appears to everyone.</p>
              <SavedInput
                id={`${id}-name`}
                value={workflow.name}
                onSave={(typed) => {
                  if (typed) void update({ name: typed });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Label htmlFor={`${id}-slug`}>Slug</Label>
              <p className="text-xs text-muted-foreground">Used in its web address.</p>
              <SavedInput
                id={`${id}-slug`}
                value={workflow.slug ?? ""}
                placeholder="e.g. orders"
                tidy={(typed) => toSlug(typed) ?? ""}
                onSave={(typed) => void update({ slug: typed || null })}
              />
            </div>
          </div>
        </section>
        <section aria-label="Workflow blueprint" className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">Workflow blueprint</h2>
          <div className="rounded-xl border border-border bg-card">
            <ActionRow
              title={definition.name}
              description={`${plural(steps, "step", "steps")}. This shared blueprint owns the steps and fields. Configure people below for this workflow.`}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link
                      to="/settings/workflow-blueprints/$definitionId"
                      params={{ definitionId: definition.id }}
                    />
                  }
                >
                  Open blueprint
                </Button>
              }
            />
          </div>
        </section>
        <WorkflowStepPeople detail={detail} busy={busy} run={run} />
        <WorkflowPeople detail={detail} busy={busy} run={run} />
        <WorkflowDangerZone detail={detail} busy={busy} run={run} />
      </div>
    </WorkFrame>
  );
}
