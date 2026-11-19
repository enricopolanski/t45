import { useTranslation } from "~/i18n/locale";
import { Link } from "@tanstack/react-router";

import { api } from "../../rpc/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { WorkflowNavigation } from "./WorkflowNavigation";
import { WorkFrame } from "../work/WorkFrame";
import { useWorkflowData } from "./useWorkflowData";

const loadProjects = () => api("workflows.listProjects", undefined);

/** The projects I manage. Organization admins manage every project. */
export function ProjectList() {
  const t = useTranslation();
  const { detail: projects, error } = useWorkflowData(loadProjects);
  return (
    <WorkFrame
      title={t("Projects")}
      actions={
        <>
          <WorkflowNavigation />
          <Button size="sm" render={<Link to="/settings/projects/new" />}>
            {t("New project")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "Projects use a workflow and configure who does the work. Each ticket is one run of that project.",
        )}
      </p>
      <section aria-label={t("Projects")} className="flex flex-col gap-3">
        {error && <ErrorText text={error} />}
        {projects !== null && projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No projects yet. Choose a workflow to configure a project for your team.")}
          </p>
        ) : null}
        {projects?.map(({ project, workflow }) => (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{project.name}</p>
              <p className="text-xs text-muted-foreground">
                {t("Workflow:")} {workflow.name}
              </p>
            </div>
            {project.isArchived ? <Badge variant="secondary">{t("Archived")}</Badge> : null}
            <Button
              size="sm"
              variant="ghost"
              render={
                <Link to="/settings/projects/$projectId/edit" params={{ projectId: project.id }} />
              }
            >
              {t("Edit")}
            </Button>
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}
