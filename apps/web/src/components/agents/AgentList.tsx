import { canManage, isBuiltIn } from "@t45/contracts/models/Agent";
import type { AgentSummary } from "@t45/contracts/resources/Agents";
import { Link } from "@tanstack/react-router";
import { useTransition } from "react";

import { agentActions, useAgents, useSkills } from "../../state/agents";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useIsAdmin, useSession } from "../../state/session";
import { Section } from "../Section";

/** Organization-wide skills agents can use. Only admins write them. */
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
 * The agents a member can use or manage, and the skills they use. Everyone builds agents on their
 * own pages; a new one is private until its creator publishes it. Organization admins manage
 * everyone's agents and the skills.
 */
export function AgentList() {
  const isAdmin = useIsAdmin();
  return (
    <>
      <AgentsSection />
      {isAdmin ? <SkillsSection /> : null}
    </>
  );
}

function AgentsSection() {
  const member = useSession();
  const agents = useAgents().filter(
    (agent) => agent.status === "active" || (member !== null && canManage(agent, member)),
  );
  return (
    <Section
      title="Agents"
      description="Each agent has its own instructions and model, and works in a folder of its own in every chat."
      action={
        <Button size="sm" variant="outline" render={<Link to="/settings/agents/new" />}>
          New agent
        </Button>
      }
      card
    >
      {agents.length === 0 ? <p className="text-sm text-muted-foreground">No agents yet.</p> : null}
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </Section>
  );
}

function AgentRow({ agent }: { readonly agent: AgentSummary }) {
  const member = useSession();
  const [busy, startTransition] = useTransition();
  const active = agent.status === "active";
  const canChange = member !== null && canManage(agent, member) && !isBuiltIn(agent.id);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3">
      {canChange && active ? (
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
      {isBuiltIn(agent.id) ? (
        <Badge variant="secondary" size="sm">
          Built-in
        </Badge>
      ) : null}
      {agent.isPublished ? null : (
        <Badge variant="secondary" size="sm">
          Private
        </Badge>
      )}
      {agent.isConversational ? (
        <Badge variant="info" size="sm">
          In Chat
        </Badge>
      ) : null}
      <span className="flex-1" />
      {active && !agent.isPublished && agent.creatorUserId === member?.userId ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => startTransition(() => agentActions.publish(agent.id))}
        >
          Publish
        </Button>
      ) : null}
      {canChange && active ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          title="For good: an archived agent takes no new work and can't be restored."
          onClick={() => startTransition(() => agentActions.archive(agent.id))}
        >
          Archive
        </Button>
      ) : null}
    </div>
  );
}
