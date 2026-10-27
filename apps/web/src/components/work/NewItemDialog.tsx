import type { Workflow } from "@t45/contracts/models/Workflow";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { useStartableWorkflows, workChanged } from "../../state/work";
import { FormDialog } from "../FormDialog";
import { Loading } from "../Loading";
import { Button } from "../ui/button";
import { DialogTrigger } from "../ui/dialog";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const NO_WORKFLOW = "There's no workflow you can start items in yet.";

/**
 * Starts an item with a title, in a workflow the viewer picks from those they may start, or in
 * the given one, and opens its first step. The workflow's admins set a due date afterwards.
 */
export function NewItemDialog({ workflow }: { readonly workflow?: Workflow }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <DialogTrigger render={<Button size="sm" />}>
          <PlusIcon />
          New item
        </DialogTrigger>
      }
      title={workflow === undefined ? "New item" : `New item in ${workflow.name}`}
      submitLabel="Start"
      onSubmit={async (fields) => {
        const workflowId = fields.get("workflowId");
        if (typeof workflowId !== "string") return false;
        const description = String(fields.get("description"));
        const result = await api("workflows.startTicket", {
          workflowId,
          title: String(fields.get("title")),
          ...(description.trim() ? { description } : {}),
        });
        workChanged();
        void navigate({ to: "/my-work/$stepId", params: result });
      }}
    >
      {workflow === undefined ? (
        <Loading>
          <WorkflowChoice />
        </Loading>
      ) : (
        <input type="hidden" name="workflowId" value={workflow.id} />
      )}
      <Field label="Title">
        <Input name="title" required pattern=".*\S.*" placeholder="e.g. Customer onboarding" />
      </Field>
      <Field label="Description (optional)">
        <Textarea
          name="description"
          placeholder="What this item is about, for everyone who works on it"
        />
      </Field>
    </FormDialog>
  );
}

function WorkflowChoice() {
  const workflows = useStartableWorkflows();
  if (workflows.length === 0) return <p className="text-sm text-muted-foreground">{NO_WORKFLOW}</p>;
  return (
    <Field label="Workflow">
      <Select
        name="workflowId"
        defaultValue={workflows[0]?.id}
        items={workflows.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {workflows.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}
