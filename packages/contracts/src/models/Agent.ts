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
    capabilities: Schema.Array(StringId),
    permissions: Schema.Struct({
      /** Provider: can only reach the LLM provider. Open: can query the rest of the internet. */
      network: Schema.Literals(["provider", "open"]),
    }),
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

/** Supplied agents have no creator; their setup comes from deployment data. */
export const isBuiltIn = (agent: Pick<Agent, "creatorUserId">) => agent.creatorUserId === null;

/** A private agent works for its creator alone; organization admins get no exception. */
export const canUse = (agent: Pick<Agent, "creatorUserId" | "isPublished">, userId: string) =>
  agent.isPublished || agent.creatorUserId === userId;

/** Its creator and organization admins read an agent's setup, change it and archive it. */
export const canManage = (
  agent: Pick<Agent, "creatorUserId">,
  member: { readonly userId: string; readonly role: Role },
) => member.role === "admin" || agent.creatorUserId === member.userId;

export const canChatWithMembers = (agent: Pick<Agent, "status" | "isConversational">) =>
  agent.status === "active" && agent.isConversational;

const REFUSALS = {
  name_taken: "Another agent already has that name.",
  model_unavailable:
    "OpenCode Go doesn't offer that model now. Choose another, or try again once it answers.",
  skill_not_found: "That skill no longer exists.",
  capability_not_found: "That capability no longer exists.",
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
