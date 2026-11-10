import type { Workflow } from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PersonPicker } from "../work/PersonPicker";
import { WorkFrame } from "../work/WorkFrame";

/** Configures a project from an existing shared workflow. */
export function NewProject({
  workflowId: selectedWorkflowId,
}: {
  readonly workflowId?: string | undefined;
}) {
  const id = useId();
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<ReadonlyArray<Workflow> | null>(null);
  const [workflowId, setWorkflowId] = useState(selectedWorkflowId ?? "");
  const [name, setName] = useState("");
  const [responsible, setResponsible] = useState<StringId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api("workflows.listWorkflows", undefined).then(
      (loaded) => {
        if (!current) return;
        const active = loaded.filter((workflow) => !workflow.isArchived);
        setWorkflows(active);
        const selected = active.find((workflow) => workflow.id === selectedWorkflowId);
        if (selected) setName(selected.name);
        else setWorkflowId("");
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [selectedWorkflowId]);

  const submit = () => {
    if (!workflowId || !name.trim() || responsible === null) return;
    setBusy(true);
    setError(null);
    void api("workflows.createProject", { workflowId, name: name.trim(), responsible }).then(
      ({ projectId }) =>
        void navigate({ to: "/settings/projects/$projectId/edit", params: { projectId } }),
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  return (
    <WorkFrame title="New project">
      <p className="text-sm text-muted-foreground">
        Choose a shared workflow, then configure this project's people and assignments.
      </p>
      <form
        aria-label="New project"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-workflow`}>Workflow</Label>
          <Select
            value={workflowId || null}
            disabled={busy || workflows === null}
            onValueChange={(key) => {
              const selected = workflows?.find((workflow) => workflow.id === key);
              if (!selected) return;
              const previous = workflows?.find((workflow) => workflow.id === workflowId);
              setWorkflowId(selected.id);
              if (!name.trim() || name === previous?.name) setName(selected.name);
            }}
          >
            <SelectTrigger id={`${id}-workflow`} aria-label="Workflow">
              <SelectValue
                placeholder={workflows === null ? "Loading workflows…" : "Choose a workflow"}
              >
                {(key: string) =>
                  workflows?.find((workflow) => workflow.id === key)?.name ?? "Choose a workflow"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {workflows?.map((workflow) => (
                <SelectItem key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {workflows?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a workflow before configuring a project.
            </p>
          ) : null}
          <Link to="/settings/workflows/new" className="text-xs text-primary underline">
            Create a new workflow
          </Link>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Project name</Label>
          <p className="text-xs text-muted-foreground">
            Name this configuration for your team, for example Engineering hiring.
          </p>
          <Input
            id={`${id}-name`}
            value={name}
            placeholder="Hiring"
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-responsible`}>Responsible</Label>
          <p className="text-xs text-muted-foreground">Who answers for this process.</p>
          <PersonPicker
            id={`${id}-responsible`}
            aria-label="Responsible"
            value={responsible}
            onChange={setResponsible}
            placeholder="Choose a person"
            disabled={busy}
          />
        </div>
        {error && <ErrorText text={error} />}
        <div>
          <Button
            type="submit"
            disabled={busy || !name.trim() || !workflowId || responsible === null}
          >
            Create project
          </Button>
        </div>
      </form>
    </WorkFrame>
  );
}
