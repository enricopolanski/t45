import { Link } from "@tanstack/react-router";

import { api } from "../../rpc/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { WorkflowNavigation } from "./WorkflowNavigation";
import { WorkFrame } from "../work/WorkFrame";
import { useWorkflowData } from "./useWorkflowData";

const loadProjects = () => api("workflows.listProjects", undefined);

/**
 * The projects I manage, and those I answer for as their responsible, who opens the board but
 * doesn't edit. Organization admins manage every project.
 */
export function ProjectList() {
  const { detail: projects, error } = useWorkflowData(loadProjects);
  return (
    <WorkFrame
      title="Projects"
      actions={
        <>
          <WorkflowNavigation />
          <Button size="sm" render={<Link to="/settings/projects/new" />}>
            New project
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Projects use a workflow and configure who does the work. Each ticket is one run of that
        project.
      </p>
      <section aria-label="Projects" className="flex flex-col gap-3">
        {error && <ErrorText text={error} />}
        {projects !== null && projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projects yet. Choose a workflow to configure a project for your team.
          </p>
        ) : null}
        {projects?.map(({ project, workflow, canManage }) => (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{project.name}</p>
              <p className="text-xs text-muted-foreground">Workflow: {workflow.name}</p>
              {canManage ? null : (
                <p className="text-xs text-muted-foreground">You're responsible</p>
              )}
            </div>
            {project.isArchived ? <Badge variant="secondary">Archived</Badge> : null}
            {workflow.steps.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/boards/$slug" params={{ slug: project.id }} />}
              >
                Board
              </Button>
            ) : null}
            {canManage ? (
              <Button
                size="sm"
                variant="ghost"
                render={
                  <Link
                    to="/settings/projects/$projectId/edit"
                    params={{ projectId: project.id }}
                  />
                }
              >
                Edit
              </Button>
            ) : null}
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}
