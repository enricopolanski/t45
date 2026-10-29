import type { AgentModels } from "@t45/contracts/resources/Agents";
import type { Agent } from "@t45/contracts/models/Agent";
import type { StringId } from "@t45/contracts/models/primitives";
import type { Skill } from "@t45/contracts/models/Skill";
import { STEP_TOOLS_MCP, WORKFLOW_DRAFTING_MCP } from "@t45/core/agentTools";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, useTransition } from "react";

import { describeFailure } from "../../lib/failures";
import { saveAgent, useAgentForm } from "../../state/agents";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ErrorText } from "../ui/error-text";
import { Section } from "../Section";
import { fileRecord, fileRows, FilesEditor, RowsEditor } from "./FilesEditor";

type McpServer = Agent["mcpServers"][string];

/**
 * An MCP server as the form edits it: the command line or URL, and KEY=VALUE lines. `server` is
 * the one it was made from, whose settings the form doesn't show, such as Code Mode, it keeps.
 */
type McpDraft = {
  readonly name: string;
  readonly type: "local" | "remote";
  readonly target: string;
  readonly entries: string;
  readonly server: McpServer | null;
};

const toDraft = ([name, server]: [string, McpServer]): McpDraft =>
  server.type === "local"
    ? {
        name,
        type: "local",
        target: server.command.join(" "),
        entries: Object.entries(server.environment ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        server,
      }
    : {
        name,
        type: "remote",
        target: server.url,
        entries: Object.entries(server.headers ?? {})
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
        server,
      };

/** Environment lines split at their first `=`, header lines at their first `:`. */
const parseEntries = (text: string, separator: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(separator))
      .map((line) => {
        const at = line.indexOf(separator);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      })
      .filter(([key]) => !!key),
  );

const fromDraft = ({ name, type, target, entries, server }: McpDraft): [string, McpServer] => [
  name,
  type === "local"
    ? {
        ...(server?.type === "local" ? server : {}),
        type,
        command: target.trim().split(/\s+/),
        environment: parseEntries(entries, "="),
      }
    : {
        ...(server?.type === "remote" ? server : {}),
        type,
        url: target.trim(),
        headers: parseEntries(entries, ":"),
      },
];

const PRESETS = [
  { mcp: WORKFLOW_DRAFTING_MCP, label: "Add workflow drafting" },
  { mcp: STEP_TOOLS_MCP, label: "Add step tools" },
] as const;

function McpServersEditor({
  servers,
  onChange,
}: {
  readonly servers: ReadonlyArray<McpDraft>;
  readonly onChange: (servers: ReadonlyArray<McpDraft>) => void;
}) {
  return (
    <RowsEditor
      rows={servers}
      onChange={onChange}
      blank={{ name: "", type: "local", target: "", entries: "", server: null }}
      addLabel="Add MCP server"
      actions={PRESETS.map(({ mcp, label }) =>
        servers.some((server) => server.name === mcp.name) ? null : (
          <Button
            key={mcp.name}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange([...servers, toDraft([mcp.name, mcp.server])])}
          >
            {label}
          </Button>
        ),
      )}
    >
      {(server, edit, remove) => (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
            <Input
              aria-label="MCP server name"
              placeholder="Name, such as files"
              required
              pattern="[A-Za-z0-9_\-]+"
              value={server.name}
              onChange={(event) => edit({ name: event.target.value })}
            />
            <Select
              value={server.type}
              onValueChange={(value) => edit({ type: value === "remote" ? "remote" : "local" })}
            >
              <SelectTrigger aria-label="MCP server type">
                <SelectValue>
                  {(value: string) => (value === "remote" ? "Remote URL" : "Local command")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="local">Local command</SelectItem>
                <SelectItem value="remote">Remote URL</SelectItem>
              </SelectPopup>
            </Select>
            {remove}
          </div>
          <Input
            aria-label={server.type === "local" ? "MCP server command" : "MCP server URL"}
            placeholder={
              server.type === "local"
                ? "Command, such as npx -y @modelcontextprotocol/server-filesystem ."
                : "URL, such as https://mcp.example.com/mcp"
            }
            required
            pattern=".*\S.*"
            value={server.target}
            onChange={(event) => edit({ target: event.target.value })}
          />
          <Textarea
            aria-label={server.type === "local" ? "MCP server environment" : "MCP server headers"}
            placeholder={
              server.type === "local"
                ? "Environment, one KEY=value per line"
                : "Headers, one Name: value per line"
            }
            rows={2}
            value={server.entries}
            onChange={(event) => edit({ entries: event.target.value })}
          />
        </div>
      )}
    </RowsEditor>
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
  if (skills.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills yet.{" "}
        <Link to="/settings/agents/skills/new" className="underline">
          Create one
        </Link>
        .
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

/** Picks an agent's model from what the runner offers. */
function ModelPicker({
  models,
  value,
}: {
  readonly models: AgentModels;
  readonly value: string | null;
}) {
  if (models.reason !== null) {
    return <ErrorText text={`The runner can't list its models: ${models.reason}`} />;
  }
  return (
    <Select name="model" required defaultValue={value}>
      <SelectTrigger>
        <SelectValue placeholder="Model the runner offers">
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
  const [servers, setServers] = useState<ReadonlyArray<McpDraft>>(() =>
    Object.entries(agent?.mcpServers ?? {}).map(toDraft),
  );
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
          setError("Choose a model the runner offers.");
        } else if (new Set(servers.map((server) => server.name)).size < servers.length) {
          setError("Give each MCP server its own name.");
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
                mcpServers: Object.fromEntries(servers.map(fromDraft)),
                permissions: { network: form.get("network") === "open" ? "open" : "provider" },
                // Members chat with an agent only once an admin makes it available.
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
          description="Allow members to start conversations with this agent. It can also run automations; workflow automations require the step tools."
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
        <Section
          title="MCP servers"
          description={`Added to opencode.json in every chat's folder. Workflow drafting lets its chats draft workflows (only from the server named ${WORKFLOW_DRAFTING_MCP.name}); step tools let it take or help with workflow steps.`}
          card
        >
          <McpServersEditor servers={servers} onChange={setServers} />
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
 * The page that builds an agent: who it is, its instructions, what runs it and where, and the
 * skills, MCP servers, and files every chat's folder starts with.
 */
export function AgentEditor({ agentId }: { readonly agentId: string | null }) {
  return <AgentForm {...useAgentForm(agentId)} />;
}
