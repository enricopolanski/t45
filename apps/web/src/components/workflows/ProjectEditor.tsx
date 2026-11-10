import { toSlug } from "@t45/contracts/models/Workflow";
import type { ProjectView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";
import { useCallback, useId } from "react";

import { api, type ApiInput } from "../../rpc/api";
import { SavedInput } from "../SavedInput";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Label } from "../ui/label";
import { WorkFrame } from "../work/WorkFrame";
import { plural } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import { useWorkflowData } from "./useWorkflowData";
import { ProjectDangerZone, ProjectPeople, ProjectStepPeople } from "./ProjectPeople";

/**
 * A project as its admins shape it, in cards: its name first, a link to the step editor, its
 * people, and archiving or deleting it last. Everything here applies at once; steps are saved
 * on their own page.
 */
export function ProjectEditor({ projectId }: { readonly projectId: string }) {
  const id = useId();
  const { detail, busy, error, run } = useWorkflowData(
    useCallback(
      (current: ProjectView | null) =>
        api("workflows.getProject", { idOrSlug: current?.project.id ?? projectId }),
      [projectId],
    ),
  );

  if (detail === null) {
    return (
      <WorkFrame title="Project">
        <p role={error !== null ? "alert" : undefined} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  }

  const { project, workflow } = detail;
  const steps = detail.workflow.steps.length;
  const update = (change: Omit<ApiInput<"workflows.updateProject">, "projectId">) =>
    run(() => api("workflows.updateProject", { projectId: project.id, ...change }));

  return (
    <WorkFrame
      title={project.name}
      actions={
        steps > 0 ? (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/boards/$slug" params={{ slug: project.id }} />}
          >
            Board
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        This project uses the {workflow.name} workflow. Its name, people and assignments belong to
        this project.
      </p>
      <div className="flex flex-col gap-6">
        {error && <ErrorText text={error} />}
        <section aria-label="General" className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">General</h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <p className="text-xs text-muted-foreground">How this process appears to everyone.</p>
              <SavedInput
                id={`${id}-name`}
                value={project.name}
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
                value={project.slug ?? ""}
                placeholder="e.g. orders"
                tidy={(typed) => toSlug(typed) ?? ""}
                onSave={(typed) => void update({ slug: typed || null })}
              />
            </div>
          </div>
        </section>
        <section aria-label="Workflow" className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">Workflow</h2>
          <div className="rounded-xl border border-border bg-card">
            <ActionRow
              title={workflow.name}
              description={`${plural(steps, "step", "steps")}. This shared workflow owns the steps and fields. Configure people below for this project.`}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link
                      to="/settings/workflows/$workflowId"
                      params={{ workflowId: workflow.id }}
                    />
                  }
                >
                  Open workflow
                </Button>
              }
            />
          </div>
        </section>
        <ProjectStepPeople detail={detail} busy={busy} run={run} />
        <ProjectPeople detail={detail} busy={busy} run={run} />
        <ProjectDangerZone detail={detail} busy={busy} run={run} />
      </div>
    </WorkFrame>
  );
}
