import { useTranslation } from "~/i18n/locale";
import type { WorkflowDraft } from "@t45/contracts/resources/AgentTools";
import { Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { editsBetween } from "../workflows/workflowLogic";

/** Which drafts this browser saved as workflows, so a reload opens the same workflow. */
const createdKey = (itemId: string) => `t45.workflowDraft.workflow.${itemId}`;
const readCreated = (itemId: string): string | null => {
  try {
    return window.localStorage.getItem(createdKey(itemId));
  } catch {
    return null;
  }
};
const rememberCreated = (itemId: string, workflowId: string) => {
  try {
    window.localStorage.setItem(createdKey(itemId), workflowId);
  } catch {}
};

function DraftSteps({ steps }: { readonly steps: WorkflowDraft["steps"] }) {
  const t = useTranslation();
  return (
    <ol className="flex flex-col gap-1.5 list-decimal ps-4">
      {steps.map((step) => (
        <li key={step.id} className="text-sm text-foreground">
          <span className="font-medium">{step.name}</span>
          <span className="text-muted-foreground">
            {` · ${t(step.fields.length === 1 ? "{0} field" : "{0} fields", step.fields.length)}`}
            {step.subSteps.length > 0
              ? ` · ${t(step.subSteps.length === 1 ? "{0} sub-step" : "{0} sub-steps", step.subSteps.length)}`
              : null}
          </span>
          {step.subSteps.length > 0 ? <DraftSteps steps={step.subSteps} /> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Saves an agent's draft as a reusable workflow. Configuring a project from it is a separate
 * action. `itemId` names the tool call, so a reload opens the same workflow.
 */
export function WorkflowDraftCard(props: {
  readonly itemId: string;
  readonly draft: WorkflowDraft;
}) {
  const t = useTranslation();
  const { draft, itemId } = props;
  const [workflowId, setWorkflowId] = useState(() => readCreated(itemId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setCreating(true);
    setError(null);
    void api("workflows.createWorkflow", {
      name: draft.name,
      edits: editsBetween([], draft.steps),
    })
      .then(
        (created) => {
          rememberCreated(itemId, created.workflowId);
          setWorkflowId(created.workflowId);
        },
        (cause: unknown) => setError(describeFailure(cause)),
      )
      .finally(() => setCreating(false));
  };

  return (
    <section
      aria-label={t("Workflow draft {0}", draft.name)}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">{t("Workflow draft")}</span>
          <span className="truncate text-sm font-medium text-foreground">{draft.name}</span>
        </div>
      </div>
      <DraftSteps steps={draft.steps} />
      {error && <ErrorText text={error} />}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {workflowId === null
            ? t("Save this workflow, then create a project to choose its people and adopt it.")
            : t("Workflow saved. Create a project from its page.")}
        </p>
        {workflowId === null ? (
          <Button size="sm" disabled={creating} onClick={create}>
            {t("Save workflow")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/settings/workflows/$workflowId" params={{ workflowId }} />}
          >
            {t("Open workflow")}
          </Button>
        )}
      </div>
    </section>
  );
}
