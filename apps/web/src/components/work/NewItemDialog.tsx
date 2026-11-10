import type { Project } from "@t45/contracts/models/Workflow";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { useStartableProjects, workChanged } from "../../state/work";
import { FormDialog } from "../FormDialog";
import { Loading } from "../Loading";
import { Button } from "../ui/button";
import { DialogTrigger } from "../ui/dialog";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const NO_PROJECT = "There's no project you can start items in yet.";

/**
 * Starts an item with a title, in a project the viewer picks from those they may start, or in
 * the given one, and opens its first step.
 */
export function NewItemDialog({ project }: { readonly project?: Pick<Project, "id" | "name"> }) {
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
      title={project === undefined ? "New item" : `New item in ${project.name}`}
      submitLabel="Start"
      onSubmit={async (fields) => {
        const projectId = fields.get("projectId");
        if (typeof projectId !== "string") return false;
        const description = String(fields.get("description"));
        const result = await api("workflows.startTicket", {
          projectId,
          title: String(fields.get("title")),
          ...(description.trim() ? { description } : {}),
        });
        workChanged();
        void navigate({ to: "/my-work/$stepId", params: result });
      }}
    >
      {project === undefined ? (
        <Loading>
          <ProjectChoice />
        </Loading>
      ) : (
        <input type="hidden" name="projectId" value={project.id} />
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

function ProjectChoice() {
  const projects = useStartableProjects();
  if (projects.length === 0) return <p className="text-sm text-muted-foreground">{NO_PROJECT}</p>;
  return (
    <Field label="Project">
      <Select
        name="projectId"
        defaultValue={projects[0]?.id}
        items={projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {projects.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}
