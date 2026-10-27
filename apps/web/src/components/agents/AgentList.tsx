import type { Agent } from "@t45/contracts/models/Agent";
import { Link } from "@tanstack/react-router";
import { useTransition } from "react";

import { agentActions, useAgents, useSkills } from "../../state/agents";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useIsAdmin } from "../../state/session";
import { Section } from "../Section";

/** Organization-wide skills agents can use. Admins only, like agent setups. */
function SkillsSection() {
  const skills = useSkills();
  return (
    <Section
      title="Skills"
      description="Reusable know-how with its scripts. Pick them per agent; its chats get them in their folder."
      action={
        <Button size="sm" variant="outline" render={<Link to="/settings/agents/skills/new" />}>
          New skill
        </Button>
      }
      card
    >
      {skills.length === 0 ? <p className="text-sm text-muted-foreground">No skills yet.</p> : null}
      {skills.map((skill) => {
        const fileCount = Object.keys(skill.files).length;
        return (
          <Link
            key={skill.id}
            to="/settings/agents/skills/$skillId"
            params={{ skillId: skill.id }}
            className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted"
          >
            <span className="font-mono text-sm">{skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {skill.description}
            </span>
            {fileCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                {fileCount} {fileCount === 1 ? "file" : "files"}
              </span>
            ) : null}
          </Link>
        );
      })}
    </Section>
  );
}

/**
 * Organization-wide agents and the skills they use. Everyone sees the agents; organization admins
 * build them on their own pages, archive and restore them, and manage skills.
 */
export function AgentList() {
  const canManage = useIsAdmin();
  return (
    <>
      <AgentsSection canManage={canManage} />
      {canManage ? <SkillsSection /> : null}
    </>
  );
}

function AgentsSection({ canManage }: { readonly canManage: boolean }) {
  const agents = useAgents().filter((agent) => canManage || agent.status === "active");
  return (
    <Section
      title="Agents"
      description="Each agent has its own instructions and model, and works in a folder of its own in every chat."
      action={
        canManage ? (
          <Button size="sm" variant="outline" render={<Link to="/settings/agents/new" />}>
            New agent
          </Button>
        ) : null
      }
      card
    >
      {agents.length === 0 ? <p className="text-sm text-muted-foreground">No agents yet.</p> : null}
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} canManage={canManage} />
      ))}
    </Section>
  );
}

function AgentRow({ agent, canManage }: { readonly agent: Agent; readonly canManage: boolean }) {
  const [busy, startTransition] = useTransition();
  const active = agent.status === "active";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3">
      {canManage && active ? (
        <Link
          to="/settings/agents/$agentId"
          params={{ agentId: agent.id }}
          className="text-sm font-medium hover:underline"
        >
          {agent.name}
        </Link>
      ) : (
        <span className="text-sm font-medium">{agent.name}</span>
      )}
      {active ? null : (
        <Badge variant="secondary" size="sm">
          Archived
        </Badge>
      )}
      {agent.permissions.network === "open" ? (
        <Badge variant="outline" size="sm">
          Reaches the internet
        </Badge>
      ) : null}
      {agent.isConversational ? (
        <Badge variant="info" size="sm">
          In Chat
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agent.model}</span>
      {canManage ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            startTransition(() =>
              active ? agentActions.archive(agent.id) : agentActions.restore(agent.id),
            )
          }
        >
          {active ? "Archive" : "Restore"}
        </Button>
      ) : null}
    </div>
  );
}
