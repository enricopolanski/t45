import type { AgentModels } from "@t45/contracts/resources/Agents";
import {
  type Agent,
  type AppTool,
  PROJECT_TOOLS_MCP_NAME,
  STEP_TOOLS_MCP_NAME,
  WORKFLOW_DRAFTING_MCP_NAME,
} from "@t45/contracts/models/Agent";
import type { StringId } from "@t45/contracts/models/primitives";
import type { Skill } from "@t45/contracts/models/Skill";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, useTransition } from "react";

import { describeFailure } from "../../lib/failures";
import { saveAgent, useAgentForm } from "../../state/agents";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ErrorText } from "../ui/error-text";
import { Section } from "../Section";
import { fileRecord, fileRows, FilesEditor } from "./FilesEditor";

const APP_TOOLS: ReadonlyArray<{
  readonly tool: AppTool;
  readonly name: string;
  readonly description: string;
}> = [
  {
    tool: WORKFLOW_DRAFTING_MCP_NAME,
    name: "Workflow drafting",
    description: "Its chats draft workflows for the member to save.",
  },
  {
    tool: PROJECT_TOOLS_MCP_NAME,
    name: "Project operations",
    description: "Its chats belong to a project: it reads tickets, starts them and fills fields.",
  },
  {
    tool: STEP_TOOLS_MCP_NAME,
    name: "Step tools",
    description: "Workflow automations can run it on a step, where it fills fields and comments.",
  },
];

function AppToolPicker({
  selected,
  disabled,
}: {
  readonly selected: ReadonlyArray<AppTool>;
  readonly disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {APP_TOOLS.map(({ tool, name, description }) => (
        <label
          key={tool}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
        >
          <Checkbox
            name="appTools"
            value={tool}
            aria-label={`Use ${name}`}
            defaultChecked={selected.includes(tool)}
            disabled={disabled}
          />
          <span className="min-w-0">
            <span className="block text-sm">{name}</span>
            <span className="block text-xs text-muted-foreground">{description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function SkillPicker({
  skills,
  selected,
  disabled,
}: {
  readonly skills: ReadonlyArray<Skill>;
  readonly selected: ReadonlyArray<StringId>;
  readonly disabled: boolean;
}) {
  const isAdmin = useIsAdmin();
  if (skills.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills yet.
        {isAdmin ? (
          <>
            {" "}
            <Link to="/settings/agents/skills/new" className="underline">
              Create one
            </Link>
            .
          </>
        ) : null}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {skills.map((skill) => (
        <label
          key={skill.id}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
        >
          <Checkbox
            name="skills"
            value={skill.id}
            aria-label={`Use ${skill.name}`}
            defaultChecked={selected.includes(skill.id)}
            disabled={disabled}
          />
          <span className="min-w-0">
            <span className="block font-mono text-sm">{skill.name}</span>
            <span className="block text-xs text-muted-foreground">{skill.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ModelPicker({
  models,
  value,
}: {
  readonly models: AgentModels;
  readonly value: string | null;
}) {
  if (models.reason !== null) {
    return <ErrorText text={`T45 can't list the models: ${models.reason}`} />;
  }
  return (
    <Select name="model" required defaultValue={value}>
      <SelectTrigger>
        <SelectValue placeholder="Choose a model">
          {(slug: string) => models.models.find((model) => model.slug === slug)?.name ?? slug}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {models.models.map((model) => (
          <SelectItem key={model.slug} value={model.slug}>
            {model.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const NETWORKS: Record<Agent["permissions"]["network"], string> = {
  provider: "Reaches only its provider",
  open: "Reaches the internet",
};

function AgentForm({
  agent,
  skills,
  models,
}: {
  readonly agent: Agent | null;
  readonly skills: ReadonlyArray<Skill>;
  readonly models: AgentModels;
}) {
  const navigate = useNavigate();
  const [files, setFiles] = useState(() => fileRows(agent?.files ?? {}));
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  return (
    <form
      aria-label={agent ? `Edit ${agent.name}` : "New agent"}
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const model = form.get("model") ?? agent?.model;
        if (typeof model !== "string" || model === "") {
          setError("Choose a model.");
        } else {
          startTransition(async () => {
            setError(null);
            try {
              await saveAgent(agent?.id ?? null, {
                name: String(form.get("name")).trim(),
                instructions: String(form.get("instructions")),
                model,
                files: fileRecord(files),
                skills: form.getAll("skills").map(String),
                appTools: APP_TOOLS.map(({ tool }) => tool).filter((tool) =>
                  form.getAll("appTools").includes(tool),
                ),
                permissions: { network: form.get("network") === "open" ? "open" : "provider" },
                isConversational: form.has("isConversational"),
              });
              await navigate({ to: "/settings/agents" });
            } catch (cause) {
              setError(describeFailure(cause));
            }
          });
        }
      }}
    >
      <fieldset disabled={busy} className="contents">
        <Section title="Identity" card>
          <Field label="Name">
            <Input
              name="name"
              required
              pattern=".*\S.*"
              placeholder="e.g. Business analyst"
              defaultValue={agent?.name}
            />
          </Field>
        </Section>
        <Section
          title="Instructions"
          description="Written to AGENTS.md in every chat's folder."
          card
        >
          <Textarea
            name="instructions"
            aria-label="Agent instructions"
            placeholder="What this agent does, how it works, and what it hands back"
            rows={12}
            defaultValue={agent?.instructions}
          />
        </Section>
        <Section title="Execution" card>
          <Field label="Model">
            <ModelPicker models={models} value={agent?.model ?? models.models[0]?.slug ?? null} />
          </Field>
        </Section>
        <Section title="Network" description="Every chat gets a virtual machine of its own." card>
          <Select name="network" defaultValue={agent?.permissions.network ?? "provider"}>
            <SelectTrigger aria-label="Network">
              <SelectValue>
                {(value: Agent["permissions"]["network"]) => NETWORKS[value]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="provider">{NETWORKS.provider}</SelectItem>
              <SelectItem value="open">{NETWORKS.open}</SelectItem>
            </SelectPopup>
          </Select>
        </Section>
        <Section
          title="Chat"
          description="Allow whoever can use this agent to start conversations with it. It can also run automations; workflow automations require the step tools."
          card
        >
          <label className="flex items-center justify-between gap-3 text-sm">
            Available in Chat
            <Switch
              name="isConversational"
              aria-label="Available in Chat"
              defaultChecked={agent?.isConversational ?? false}
              disabled={busy}
            />
          </label>
        </Section>
        <Section
          title="Skills"
          description="Written to .opencode/skills/ in every chat's folder."
          card
        >
          <SkillPicker skills={skills} selected={agent?.skills ?? []} disabled={busy} />
        </Section>
        <Section title="Tools" description="What the agent can do in T45." card>
          <AppToolPicker selected={agent?.appTools ?? []} disabled={busy} />
        </Section>
        <Section
          title="Files"
          description="Copied into every chat's folder. Files sent to the chat go in attachments/."
          card
        >
          <FilesEditor files={files} onChange={setFiles} />
        </Section>
        {error && <ErrorText text={error} />}
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            {agent ? "Save agent" : "Create agent"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/agents" })}
          >
            Cancel
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

/**
 * The page that builds an agent: who it is, its instructions, what runs it and where, its tools,
 * and the skills and files every chat's folder starts with.
 */
export function AgentEditor({ agentId }: { readonly agentId: string | null }) {
  return <AgentForm {...useAgentForm(agentId)} />;
}
