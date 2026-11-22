import { useTranslation } from "~/i18n/locale";
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
  const t = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <DialogTrigger render={<Button size="sm" />}>
          <PlusIcon />
          {t("New item")}
        </DialogTrigger>
      }
      title={project === undefined ? t("New item") : t("New item in {0}", project.name)}
      submitLabel={t("Start")}
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
      <Field label={t("Title")}>
        <Input name="title" required pattern=".*\S.*" placeholder={t("e.g. Customer onboarding")} />
      </Field>
      <Field label={t("Description (optional)")}>
        <Textarea
          name="description"
          placeholder={t("What this item is about, for everyone who works on it")}
        />
      </Field>
    </FormDialog>
  );
}

function ProjectChoice() {
  const t = useTranslation();
  const projects = useStartableProjects();
  if (projects.length === 0) return <p className="text-sm text-muted-foreground">{NO_PROJECT}</p>;
  return (
    <Field label={t("Project")}>
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
