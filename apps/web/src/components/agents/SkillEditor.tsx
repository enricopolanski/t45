import { Name, type Skill } from "@t45/contracts/models/Skill";
import { useNavigate } from "@tanstack/react-router";
import { useState, useTransition } from "react";

import { describeFailure } from "../../lib/failures";
import { deleteSkill, saveSkill, useSkill } from "../../state/agents";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ErrorText } from "../ui/error-text";
import { LoadPending } from "../Loading";
import { Section } from "../Section";
import { fileRecord, fileRows, FilesEditor } from "./FilesEditor";

function SkillForm({ skill }: { readonly skill: Skill | null }) {
  const navigate = useNavigate();
  // Rows while editing, so a path can be blank or repeated until it's saved.
  const [files, setFiles] = useState(() => fileRows(skill?.files ?? {}));
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const run = (work: () => Promise<unknown>) =>
    startTransition(async () => {
      setError(null);
      try {
        await work();
        await navigate({ to: "/settings/agents" });
      } catch (cause) {
        setError(describeFailure(cause));
      }
    });
  return (
    <form
      aria-label={skill ? `Edit ${skill.name}` : "New skill"}
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        run(() =>
          saveSkill(skill?.id ?? null, {
            name: Name.make(String(form.get("name"))),
            description: String(form.get("description")).trim(),
            content: String(form.get("content")),
            files: fileRecord(files),
          }),
        );
      }}
    >
      <fieldset disabled={busy} className="contents">
        <Section
          title="Skill"
          description="Agents read the description to decide when to use the skill."
          card
        >
          <Field label="Name">
            <Input
              name="name"
              required
              maxLength={64}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="e.g. read-excel"
              defaultValue={skill?.name}
              onChange={(event) => {
                const input = event.currentTarget;
                const name = input.value.toLowerCase().replace(/[\s_]+/g, "-");
                if (name !== input.value) input.value = name;
              }}
            />
          </Field>
          <Field label="Description">
            <Input
              name="description"
              required
              pattern=".*\S.*"
              maxLength={1024}
              placeholder="When to use it, e.g. Extracts tables from .xlsx files"
              defaultValue={skill?.description}
            />
          </Field>
        </Section>
        <Section title="SKILL.md" description="How to do the job, step by step." card>
          <Textarea
            name="content"
            aria-label="Skill instructions"
            placeholder="Run scripts/read.py <file> and summarize the sheets it prints."
            rows={12}
            defaultValue={skill?.content}
          />
        </Section>
        <Section
          title="Files"
          description="Scripts and references next to SKILL.md. Files starting with #! are executable."
          card
        >
          <FilesEditor files={files} onChange={setFiles} />
        </Section>
        {error && <ErrorText text={error} />}
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            {skill ? "Save skill" : "Create skill"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/agents" })}
          >
            Cancel
          </Button>
          {skill ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                if (window.confirm(`Delete ${skill.name}?\nEvery agent that uses it loses it.`)) {
                  run(() => deleteSkill(skill.id));
                }
              }}
            >
              Delete skill
            </Button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}

export function SkillEditor({ skillId }: { readonly skillId: string | null }) {
  return skillId === null ? <SkillForm skill={null} /> : <EditSkill skillId={skillId} />;
}

function EditSkill({ skillId }: { readonly skillId: string }) {
  const skill = useSkill(skillId);
  return skill ? <SkillForm skill={skill} /> : <LoadPending />;
}
