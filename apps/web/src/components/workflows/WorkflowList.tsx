import type { WorkflowInstanceListEntryView } from "@t45/contracts/resources/Workflows";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { WorkflowNavigation } from "./WorkflowNavigation";
import { WorkFrame } from "../work/WorkFrame";

/**
 * The workflows I manage, and those I answer for as their responsible, who opens the board but
 * doesn't edit. Organization admins manage every workflow.
 */
export function WorkflowList() {
  const [workflows, setWorkflows] = useState<ReadonlyArray<WorkflowInstanceListEntryView> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api("workflows.listInstances", undefined).then(
      (loaded) => {
        if (current) setWorkflows(loaded);
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, []);
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
        Workflows use a blueprint and configure who does the work. Each ticket is one run of that
        workflow.
      </p>
      <section aria-label="Workflows" className="flex flex-col gap-3">
        {error && <ErrorText text={error} />}
        {workflows !== null && workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workflows yet. Choose a blueprint to configure a workflow for your team.
          </p>
        ) : null}
        {workflows?.map(({ workflow, definition, canManage }) => (
          <div
            key={workflow.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{workflow.name}</p>
              <p className="text-xs text-muted-foreground">Blueprint: {definition.name}</p>
              {canManage ? null : (
                <p className="text-xs text-muted-foreground">You're responsible</p>
              )}
            </div>
            {workflow.isArchived ? <Badge variant="secondary">Archived</Badge> : null}
            {definition.steps.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/boards/$slug" params={{ slug: workflow.id }} />}
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
                    to="/settings/workflows/$workflowId/edit"
                    params={{ workflowId: workflow.id }}
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
