import type { WorkflowDraft } from "@t45/contracts/resources/AgentTools";
import { Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { plural } from "../work/workLogic";
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
  return (
    <ol className="flex flex-col gap-1.5 list-decimal ps-4">
      {steps.map((step) => (
        <li key={step.id} className="text-sm text-foreground">
          <span className="font-medium">{step.name}</span>
          <span className="text-muted-foreground">
            {` · ${plural(step.fields.length, "field", "fields")}`}
            {step.subSteps.length > 0
              ? ` · ${plural(step.subSteps.length, "sub-step", "sub-steps")}`
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
      aria-label={`Workflow draft ${draft.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Workflow draft</span>
          <span className="truncate text-sm font-medium text-foreground">{draft.name}</span>
        </div>
      </div>
      <DraftSteps steps={draft.steps} />
      {error && <ErrorText text={error} />}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {workflowId === null
            ? "Save this workflow, then create a project to choose its people and adopt it."
            : "Workflow saved. Create a project from its page."}
        </p>
        {workflowId === null ? (
          <Button size="sm" disabled={creating} onClick={create}>
            Save workflow
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/settings/workflows/$workflowId" params={{ workflowId }} />}
          >
            Open workflow
          </Button>
        )}
      </div>
    </section>
  );
}
