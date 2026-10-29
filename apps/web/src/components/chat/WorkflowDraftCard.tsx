import type { StepDefinition } from "@t45/contracts/models/Workflow";
import type { WorkflowDraft } from "@t45/contracts/resources/AgentTools";
import { Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { plural } from "../work/workLogic";

/** Which drafts this browser saved as definitions, so a reload opens the same blueprint. */
const createdKey = (itemId: string) => `t45.workflowDraft.definition.${itemId}`;
const readCreated = (itemId: string): string | null => {
  try {
    return window.localStorage.getItem(createdKey(itemId));
  } catch {
    return null;
  }
};
const rememberCreated = (itemId: string, definitionId: string) => {
  try {
    window.localStorage.setItem(createdKey(itemId), definitionId);
  } catch {}
};

function DraftSteps({ steps }: { readonly steps: ReadonlyArray<StepDefinition> }) {
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
 * Saves an agent's draft as a reusable definition. Configuring a workflow from it is a separate
 * action. `itemId` names the tool call, so a reload opens the same definition.
 */
export function WorkflowDraftCard(props: {
  readonly itemId: string;
  readonly draft: WorkflowDraft;
}) {
  const { draft, itemId } = props;
  const [definitionId, setDefinitionId] = useState(() => readCreated(itemId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setCreating(true);
    setError(null);
    void api("workflows.createDefinition", { name: draft.name, steps: draft.steps })
      .then(
        (created) => {
          rememberCreated(itemId, created.definitionId);
          setDefinitionId(created.definitionId);
        },
        (cause: unknown) => setError(describeFailure(cause)),
      )
      .finally(() => setCreating(false));
  };

  return (
    <section
      aria-label={`Workflow blueprint draft ${draft.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Workflow blueprint draft</span>
          <span className="truncate text-sm font-medium text-foreground">{draft.name}</span>
        </div>
      </div>
      <DraftSteps steps={draft.steps} />
      {error && <ErrorText text={error} />}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {definitionId === null
            ? "Save this blueprint, then create a workflow to assign people."
            : "Blueprint saved. Create a workflow from its page."}
        </p>
        {definitionId === null ? (
          <Button size="sm" disabled={creating} onClick={create}>
            Save blueprint
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/settings/workflow-blueprints/$definitionId" params={{ definitionId }} />
            }
          >
            Open blueprint
          </Button>
        )}
      </div>
    </section>
  );
}
