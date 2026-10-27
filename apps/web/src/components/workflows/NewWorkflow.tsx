import type { WorkflowDefinition } from "@t45/contracts/models/Workflow";
import { StringId } from "@t45/contracts/models/primitives";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PersonPicker } from "../work/ActorPicker";
import { WorkFrame } from "../work/WorkFrame";

/** Configures a workflow from an existing shared definition. */
export function NewWorkflow({
  definitionId: selectedDefinitionId,
}: {
  readonly definitionId?: string | undefined;
}) {
  const id = useId();
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState<ReadonlyArray<WorkflowDefinition> | null>(null);
  const [definitionId, setDefinitionId] = useState(selectedDefinitionId ?? "");
  const [name, setName] = useState("");
  const [responsible, setResponsible] = useState<StringId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api("workflows.listDefinitions", undefined).then(
      (loaded) => {
        if (!current) return;
        const active = loaded.filter((definition) => definition.archivedAt === null);
        setDefinitions(active);
        const selected = active.find((definition) => definition.id === selectedDefinitionId);
        if (selected) setName(selected.name);
        else setDefinitionId("");
      },
      (cause: unknown) => {
        if (current) setError(describeFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [selectedDefinitionId]);

  const submit = () => {
    if (!definitionId || !name.trim() || responsible === null) return;
    setBusy(true);
    setError(null);
    void api("workflows.createInstance", { definitionId, name: name.trim(), responsible }).then(
      ({ workflowId }) =>
        void navigate({ to: "/settings/workflows/$workflowId/edit", params: { workflowId } }),
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  return (
    <WorkFrame title="New workflow">
      <p className="text-sm text-muted-foreground">
        Choose a shared blueprint, then configure this workflow's people and assignments.
      </p>
      <form
        aria-label="New workflow"
        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-definition`}>Workflow blueprint</Label>
          <Select
            value={definitionId || null}
            disabled={busy || definitions === null}
            onValueChange={(key) => {
              const selected = definitions?.find((definition) => definition.id === key);
              if (!selected) return;
              const previous = definitions?.find((definition) => definition.id === definitionId);
              setDefinitionId(selected.id);
              if (!name.trim() || name === previous?.name) setName(selected.name);
            }}
          >
            <SelectTrigger id={`${id}-definition`} aria-label="Workflow blueprint">
              <SelectValue
                placeholder={definitions === null ? "Loading blueprints…" : "Choose a blueprint"}
              >
                {(key: string) =>
                  definitions?.find((definition) => definition.id === key)?.name ??
                  "Choose a blueprint"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {definitions?.map((definition) => (
                <SelectItem key={definition.id} value={definition.id}>
                  {definition.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {definitions?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a blueprint before configuring a workflow.
            </p>
          ) : null}
          <Link to="/settings/workflow-blueprints/new" className="text-xs text-primary underline">
            Create a new blueprint
          </Link>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Workflow name</Label>
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
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            disabled={busy || !name.trim() || !definitionId || responsible === null}
          >
            Create workflow
          </Button>
        </div>
      </form>
    </WorkFrame>
  );
}
