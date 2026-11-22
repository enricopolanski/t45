import { useTranslation } from "~/i18n/locale";
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
import { ActionRow } from "./ActionRow";
import { useWorkflowData } from "./useWorkflowData";
import { ProjectArchive, ProjectPeople, ProjectStepPeople, ProjectTickets } from "./ProjectPeople";

/**
 * A project as those who manage it shape it, in cards: its name first, the version of its
 * workflow it adopted, its people and open tickets, and archiving it last. Everything here
 * applies at once; steps are saved on the workflow's own page.
 */
export function ProjectEditor({ projectId }: { readonly projectId: string }) {
  const t = useTranslation();
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
      <WorkFrame title={t("Project")}>
        <p role={error !== null ? "alert" : undefined} className="text-sm text-muted-foreground">
          {error ?? t("Loading…")}
        </p>
      </WorkFrame>
    );
  }

  const { project, workflow, adopted, latest } = detail;
  const update = (change: Omit<ApiInput<"workflows.updateProject">, "projectId">) =>
    run(() => api("workflows.updateProject", { projectId: project.id, ...change }));

  return (
    <WorkFrame title={project.name}>
      <p className="text-sm text-muted-foreground">
        {t("This project uses the")} {workflow.name}{" "}
        {t(
          "workflow. Its name, people and assignments belong to this project, and so does the version of the workflow its new tickets start on.",
        )}
      </p>
      <div className="flex flex-col gap-6">
        {error && <ErrorText text={error} />}
        <section aria-label={t("General")} className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">{t("General")}</h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Label htmlFor={`${id}-name`}>{t("Name")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("How this process appears to everyone.")}
              </p>
              <SavedInput
                id={`${id}-name`}
                value={project.name}
                onSave={(typed) => {
                  if (typed) void update({ name: typed });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Label htmlFor={`${id}-slug`}>{t("Slug")}</Label>
              <p className="text-xs text-muted-foreground">{t("Used in its web address.")}</p>
              <SavedInput
                id={`${id}-slug`}
                value={project.slug ?? ""}
                placeholder={t("e.g. orders")}
                tidy={(typed) => toSlug(typed) ?? ""}
                onSave={(typed) => void update({ slug: typed || null })}
              />
            </div>
          </div>
        </section>
        <section aria-label={t("Workflow")} className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold">{t("Workflow")}</h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            <ActionRow
              title={workflow.name}
              description={
                adopted === null
                  ? t("No version adopted yet, so no ticket can start.")
                  : t(
                      "New tickets start on version {0}, with {1}.",
                      adopted.number,
                      t(
                        adopted.steps.length === 1 ? "{0} step" : "{0} steps",
                        adopted.steps.length,
                      ),
                    )
              }
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
                  {t("Open workflow")}
                </Button>
              }
            />
            {adopted?.id !== latest.id && !project.isArchived && !workflow.isArchived ? (
              <ActionRow
                title={t("Adopt version {0}", latest.number)}
                description={t(
                  "{0}, each of which needs a member below first. {1}Tickets already started stay on their version.",
                  t(latest.steps.length === 1 ? "{0} step" : "{0} steps", latest.steps.length),
                  latest.isFrozen ? "" : t("It is a draft: adopting it freezes it for good. "),
                )}
                action={
                  <Button
                    size="sm"
                    disabled={busy || latest.steps.length === 0}
                    onClick={() =>
                      void run(() =>
                        api("workflows.adoptWorkflowVersion", {
                          projectId: project.id,
                          versionId: latest.id,
                          revision: latest.revision,
                        }),
                      )
                    }
                  >
                    {t("Adopt")}
                  </Button>
                }
              />
            ) : null}
          </div>
        </section>
        <ProjectStepPeople detail={detail} busy={busy} run={run} />
        <ProjectTickets detail={detail} busy={busy} run={run} />
        <ProjectPeople detail={detail} busy={busy} run={run} />
        <ProjectArchive detail={detail} busy={busy} run={run} />
      </div>
    </WorkFrame>
  );
}
