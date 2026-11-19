import { useTranslation } from "~/i18n/locale";
import type { WorkflowView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { PersonPicker } from "../work/PersonPicker";
import { useWorkDirectory } from "../work/useWorkDirectory";
import { WorkFrame } from "../work/WorkFrame";
import { actorName } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import { useWorkflowData } from "./useWorkflowData";
import { WorkflowNavigation } from "./WorkflowNavigation";

const loadWorkflows = () => api("workflows.listWorkflows", undefined);

export function WorkflowList() {
  const t = useTranslation();
  const { detail: workflows, error } = useWorkflowData(loadWorkflows);
  return (
    <WorkFrame
      title={t("Workflows")}
      actions={
        <>
          <WorkflowNavigation />
          <Button size="sm" render={<Link to="/settings/workflows/new" />}>
            {t("New workflow")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "Workflows define the process: steps, fields and rules. Create projects from them to assign people and run tickets.",
        )}
      </p>
      {error && <ErrorText text={error} />}
      {workflows?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("No workflows yet. Create a workflow to get started.")}
        </p>
      ) : null}
      <section aria-label={t("Workflows")} className="flex flex-col gap-3">
        {workflows?.map(({ workflow, version }) => (
          <div
            key={workflow.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{workflow.name}</p>
              <p className="text-xs text-muted-foreground">
                {t(version.steps.length === 1 ? "{0} step" : "{0} steps", version.steps.length)}{" "}
                {t("· Version")} {version.number}
              </p>
            </div>
            {workflow.isArchived ? (
              <Badge variant="secondary">{t("Archived")}</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/settings/projects/new" search={{ workflowId: workflow.id }} />}
              >
                {t("Create project")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              render={
                <Link to="/settings/workflows/$workflowId" params={{ workflowId: workflow.id }} />
              }
            >
              {t("Open workflow")}
            </Button>
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}

export function NewWorkflow() {
  const t = useTranslation();
  const id = useId();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  return (
    <WorkFrame title={t("New workflow")}>
      <p className="text-sm text-muted-foreground">
        {t(
          "Define the process once. Each project using it will have its own people and assignments. You are its creator: you choose who else edits it.",
        )}
      </p>
      <form
        aria-label={t("New workflow")}
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
          <Label htmlFor={`${id}-name`}>{t("Workflow name")}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            placeholder={t("Hiring process")}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>
        {error && <ErrorText text={error} />}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {t("Create workflow")}
          </Button>
        </div>
      </form>
    </WorkFrame>
  );
}

export function WorkflowEditor({ workflowId }: { readonly workflowId: string }) {
  const t = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const directory = useWorkDirectory();
  const resetName = useCallback((loaded: WorkflowView) => setName(loaded.workflow.name), []);
  const { detail, busy, error, run } = useWorkflowData(
    useCallback(() => api("workflows.getWorkflow", { workflowId }), [workflowId]),
    resetName,
  );
  if (detail === null)
    return (
      <WorkFrame title={t("Workflow")}>
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? t("Loading…")}
        </p>
      </WorkFrame>
    );
  const { workflow, version, canEdit, canSetEditors } = detail;
  const canChange = canEdit && !workflow.isArchived;
  const setEditors = (editorUserIds: ReadonlyArray<string>) =>
    void run(() => api("workflows.setWorkflowEditors", { workflowId, editorUserIds }));
  return (
    <WorkFrame
      title={workflow.name}
      actions={
        !workflow.isArchived ? (
          <Button size="sm" render={<Link to="/settings/projects/new" search={{ workflowId }} />}>
            {t("Create project")}
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "This is a shared workflow. Each project adopts a version of its steps and fields, and tickets keep the version they started on. People are assigned separately in each project.",
        )}
      </p>
      {!canEdit ? (
        <p className="text-sm text-muted-foreground">
          {t("Only this workflow's creator, its editors and organization admins can edit it.")}
        </p>
      ) : null}
      {error && <ErrorText text={error} />}
      <section
        aria-label={t("Workflow")}
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t("Workflow name")}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy || !canChange}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (name.trim() && name.trim() !== workflow.name)
                void run(() => api("workflows.renameWorkflow", { workflowId, name: name.trim() }));
            }}
          />
        </div>
        <ActionRow
          title={t(
            "Version {0} · {1}",
            version.number,
            t(version.steps.length === 1 ? "{0} step" : "{0} steps", version.steps.length),
          )}
          description={
            version.isFrozen
              ? t("In use by a project. Saving its steps starts the next version.")
              : t("A draft until a project adopts it.")
          }
          action={
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/workflows/$workflowId/steps" params={{ workflowId }} />}
            >
              {canChange ? t("Edit steps") : t("View steps")}
            </Button>
          }
        />
      </section>
      <section
        aria-label={t("Editors")}
        className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-5"
      >
        <span className="text-sm font-medium">{t("Editors")}</span>
        <p className="text-xs text-muted-foreground">
          {actorName(directory, workflow.creatorUserId)}{" "}
          {t("created this workflow. Editors change it too, as do organization admins.")}
        </p>
        <ul className="flex flex-col gap-1">
          {workflow.editorUserIds.map((userId) => {
            const editor = actorName(directory, userId);
            return (
              <li key={userId} className="flex items-center gap-2 text-sm">
                {editor}
                {canSetEditors && canChange ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("Remove editor {0}", editor)}
                    disabled={busy}
                    onClick={() => setEditors(workflow.editorUserIds.filter((id) => id !== userId))}
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canSetEditors && canChange ? (
          <PersonPicker
            aria-label={t("New editor")}
            value={null}
            onChange={(editor) => setEditors([...workflow.editorUserIds, editor])}
            placeholder={t("Add an editor")}
            disabled={busy}
          />
        ) : null}
      </section>
      <section
        aria-label={t("Workflow availability")}
        className="rounded-xl border border-border bg-card"
      >
        <ActionRow
          title={!workflow.isArchived ? t("Archive workflow") : t("Archived workflow")}
          description={t(
            "An archived workflow no longer changes, starts no new project and has no version adopted. Existing projects keep running. There's no going back.",
          )}
          action={
            workflow.isArchived ? (
              <Badge variant="secondary">{t("Archived")}</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canEdit}
                onClick={() => void run(() => api("workflows.archiveWorkflow", { workflowId }))}
              >
                {t("Archive workflow")}
              </Button>
            )
          }
        />
      </section>
    </WorkFrame>
  );
}
