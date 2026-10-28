import type { WorkflowDefinition } from "@t45/contracts/models/Workflow";
import type { WorkflowDefinitionView } from "@t45/contracts/resources/Workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { WorkFrame } from "../work/WorkFrame";
import { plural } from "../work/workLogic";
import { ActionRow } from "./ActionRow";
import { useWorkflowDefinitionDetail } from "./useWorkflowDefinitionDetail";
import { WorkflowNavigation } from "./WorkflowNavigation";

export function WorkflowDefinitions() {
  const [definitions, setDefinitions] = useState<ReadonlyArray<WorkflowDefinition> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api("workflows.listDefinitions", undefined).then(
      (loaded) => {
        if (current) setDefinitions(loaded);
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
      title="Workflow blueprints"
      actions={
        <>
          <WorkflowNavigation />
          <Button size="sm" render={<Link to="/settings/workflow-blueprints/new" />}>
            New blueprint
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Blueprints define the process: steps, fields and rules. Create workflows from them to assign
        people and run tickets.
      </p>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {definitions?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No blueprints yet. Create a blueprint to get started.
        </p>
      ) : null}
      <section aria-label="Workflow blueprints" className="flex flex-col gap-3">
        {definitions?.map((definition) => (
          <div
            key={definition.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{definition.name}</p>
              <p className="text-xs text-muted-foreground">
                {plural(definition.steps.length, "step", "steps")}
              </p>
            </div>
            {definition.isArchived ? (
              <Badge variant="secondary">Archived</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link to="/settings/workflows/new" search={{ definitionId: definition.id }} />
                }
              >
                Create workflow
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              render={
                <Link
                  to="/settings/workflow-blueprints/$definitionId"
                  params={{ definitionId: definition.id }}
                />
              }
            >
              Open blueprint
            </Button>
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}

export function NewWorkflowDefinition() {
  const id = useId();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  return (
    <WorkFrame title="New workflow blueprint">
      <p className="text-sm text-muted-foreground">
        Define the process once. Each workflow using it will have its own people and assignments.
      </p>
      <form
        aria-label="New workflow blueprint"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError(null);
          void api("workflows.createDefinition", { name: name.trim() }).then(
            ({ definitionId }) =>
              void navigate({
                to: "/settings/workflow-blueprints/$definitionId/steps",
                params: { definitionId },
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
          <Label htmlFor={`${id}-name`}>Blueprint name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            placeholder="Hiring process"
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create blueprint
          </Button>
        </div>
      </form>
    </WorkFrame>
  );
}

export function WorkflowDefinitionEditor({ definitionId }: { readonly definitionId: string }) {
  const id = useId();
  const [name, setName] = useState("");
  const adopt = useCallback(
    (loaded: WorkflowDefinitionView) => setName(loaded.definition.name),
    [],
  );
  const { detail, busy, error, run } = useWorkflowDefinitionDetail(definitionId, adopt);
  if (detail === null)
    return (
      <WorkFrame title="Workflow blueprint">
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  const { definition, canManage } = detail;
  return (
    <WorkFrame
      title={definition.name}
      actions={
        !definition.isArchived ? (
          <Button
            size="sm"
            render={<Link to="/settings/workflows/new" search={{ definitionId }} />}
          >
            Create workflow
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        This is a shared blueprint. Changes to its steps and fields apply to every workflow using
        it. People are assigned separately in each workflow.
      </p>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Editing requires admin access to every workflow using this blueprint.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <section
        aria-label="Blueprint"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Blueprint name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy || !canManage}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (name.trim() && name.trim() !== definition.name)
                void run(() =>
                  api("workflows.updateDefinition", { definitionId, name: name.trim() }),
                );
            }}
          />
        </div>
        <ActionRow
          title={plural(definition.steps.length, "step", "steps")}
          action={
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/workflow-blueprints/$definitionId/steps"
                  params={{ definitionId }}
                />
              }
            >
              {canManage ? "Edit steps" : "View steps"}
            </Button>
          }
        />
      </section>
      <section
        aria-label="Blueprint availability"
        className="rounded-xl border border-border bg-card"
      >
        <ActionRow
          title={!definition.isArchived ? "Archive blueprint" : "Archived blueprint"}
          description="Archived blueprints cannot be used to create new workflows. Existing workflows keep running."
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canManage}
              onClick={() =>
                void run(() =>
                  api("workflows.updateDefinition", {
                    definitionId,
                    isArchived: !definition.isArchived,
                  }),
                )
              }
            >
              {!definition.isArchived ? "Archive blueprint" : "Restore blueprint"}
            </Button>
          }
        />
      </section>
    </WorkFrame>
  );
}
