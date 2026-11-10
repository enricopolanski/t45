import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { FilesByPath, StringId, TrimmedNonEmptyString } from "./primitives.ts";
import type { Role } from "./User.ts";

export class AgentModel extends Schema.Opaque<AgentModel>()(
  Schema.Struct({ slug: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
) {}

/** What T45 writes in a chat's folder, and the other files OpenCode reads its configuration from. */
export const AGENT_SETUP_PATHS = [
  "AGENTS.md",
  "opencode.json",
  "opencode.jsonc",
  "attachments",
  ".opencode/skills",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
] as const;

/** T45's own tools, each named as OpenCode names its server. An agent gets no other integration. */
export const WORKFLOW_DRAFTING_MCP_NAME = "workflows";
export const STEP_TOOLS_MCP_NAME = "step";
export const PROJECT_TOOLS_MCP_NAME = "project";
export const AppTool = Schema.Literals([
  WORKFLOW_DRAFTING_MCP_NAME,
  STEP_TOOLS_MCP_NAME,
  PROJECT_TOOLS_MCP_NAME,
]);
export type AppTool = typeof AppTool.Type;

/**
 * An `Agent` is a reusable recipe (instructions, skills, configuration, etc) for work carried by LLMs.
 */
export class Agent extends Schema.Opaque<Agent>()(
  Schema.Struct({
    id: StringId,
    name: TrimmedNonEmptyString,
    instructions: Schema.String,
    model: TrimmedNonEmptyString,
    files: FilesByPath(AGENT_SETUP_PATHS),
    skills: Schema.Array(StringId),
    appTools: Schema.Array(AppTool),
    /** Provider: can only reach the LLM provider. Open: can query the rest of the internet. */
    permissions: Schema.Struct({ network: Schema.Literals(["provider", "open"]) }),
    isConversational: Schema.Boolean,
    /** Who made it; null for the agents T45 ships. */
    creatorUserId: Schema.NullOr(StringId),
    /** A new agent is private to its creator. Publishing shares it with everyone, for good. */
    isPublished: Schema.Boolean,
    status: Schema.Literals(["active", "archived"]),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/**
 * The agents T45 ships. Every release brings their setup and a server start replaces the stored
 * one, so nobody edits or archives them.
 */
export const BUILT_IN_AGENT_IDS = ["workflow-designer", "project-assistant"] as const;
export const isBuiltIn = (agentId: string) => BUILT_IN_AGENT_IDS.some((id) => id === agentId);

/** A private agent works for its creator alone; organization admins get no exception. */
export const canUse = (agent: Pick<Agent, "creatorUserId" | "isPublished">, userId: string) =>
  agent.isPublished || agent.creatorUserId === userId;

/** Its creator and organization admins read an agent's setup, change it and archive it. */
export const canManage = (
  agent: Pick<Agent, "creatorUserId">,
  member: { readonly userId: string; readonly role: Role },
) => member.role === "admin" || agent.creatorUserId === member.userId;

/** Where the runner writes T45's tools in the VM, outside the agent's /work. */
export const T45_TOOLS_DIR = "/opt/t45";

export const canChatWithMembers = (agent: Pick<Agent, "status" | "isConversational">) =>
  agent.status === "active" && agent.isConversational;

export const canWorkSteps = (agent: Pick<Agent, "status" | "appTools">) =>
  agent.status === "active" && agent.appTools.includes(STEP_TOOLS_MCP_NAME);

const REFUSALS = {
  name_taken: "Another agent already has that name.",
  model_unavailable:
    "OpenCode Go doesn't offer that model now. Choose another, or try again once it answers.",
  skill_not_found: "That skill no longer exists.",
  built_in: "T45 manages this agent, so it can't be changed or archived.",
  attached_to_workflow:
    "A workflow step runs an automation of this agent, so it can't be archived. Give that automation another agent first.",
};
export type Refusal = keyof typeof REFUSALS;

export class Refused extends Schema.TaggedError<Refused>()("AgentRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
  }
}
