import { ConfigMCP } from "@opencode/schema/config/mcp";
import * as Schema from "effect/Schema";

import { FilesByPath, StringId, TrimmedNonEmptyString } from "./primitives.ts";

export class AgentModel extends Schema.Opaque<AgentModel>()(
  Schema.Struct({ slug: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
) {}

const McpServerName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/**
 * An `Agent` is a reusable recipe (instructions, skills, configuration, etc) for work carried by LLMs.
 */
export class Agent extends Schema.Opaque<Agent>()(
  Schema.Struct({
    id: StringId,
    name: TrimmedNonEmptyString,
    instructions: Schema.String,
    model: TrimmedNonEmptyString,
    files: FilesByPath(["AGENTS.md", "opencode.json", "attachments"]),
    skills: Schema.Array(StringId),
    mcpServers: Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server)).check(
      Schema.isPropertyNames(McpServerName),
    ),
    /** Provider: can only reach the LLM provider. Open: can query the rest of the internet. */
    permissions: Schema.Struct({ network: Schema.Literals(["provider", "open"]) }),
    isConversational: Schema.Boolean,
    status: Schema.Literals(["active", "archived"]),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/** Names identify the built-in capabilities an agent is configured to use. */
export const WORKFLOW_DRAFTING_MCP_NAME = "workflows";
export const STEP_TOOLS_MCP_NAME = "step";
export const WORKFLOW_ASSISTANT_ID = "231bd9c5-6f19-44ae-88e7-fcd2b2fb5726";
export const WORKFLOW_INSTANCE_MCP_NAME = "workflow";

export const canChatWithMembers = (agent: Pick<Agent, "status" | "isConversational">) =>
  agent.status === "active" && agent.isConversational;

export const canWorkSteps = (agent: Pick<Agent, "status" | "mcpServers">) => {
  const server = agent.mcpServers[STEP_TOOLS_MCP_NAME];
  return agent.status === "active" && server !== undefined && server.disabled !== true;
};

const REFUSALS = ["name_taken", "model_unavailable", "skill_not_found"] as const;
export type Refusal = (typeof REFUSALS)[number];

export class Refused extends Schema.TaggedError<Refused>()("AgentRefused", {
  reason: Schema.Literals(REFUSALS),
}) {
  override get message(): string {
    switch (this.reason) {
      case "name_taken":
        return "Another agent already has that name.";
      case "model_unavailable":
        return "The runner doesn't offer that model now. Choose another, or try again once it answers.";
      case "skill_not_found":
        return "That skill no longer exists.";
    }
  }
}
