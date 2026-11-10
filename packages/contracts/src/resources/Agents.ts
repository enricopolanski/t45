import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Agent, AgentModel, Refused } from "../models/Agent.ts";
import { StringId } from "../models/primitives.ts";
import { AccessDenied, NotFound } from "./errors.ts";

class SaveAgentRequest extends Schema.Opaque<SaveAgentRequest>()(
  Schema.Struct(
    Struct.pick(Agent.fields, [
      "name",
      "instructions",
      "model",
      "files",
      "skills",
      "appTools",
      "permissions",
      "isConversational",
    ]),
  ),
) {}

export class AgentModels extends Schema.Opaque<AgentModels>()(
  Schema.Struct({ models: Schema.Array(AgentModel), reason: Schema.NullOr(Schema.String) }),
) {}

/** What a member reads of the agents they can use or manage: never the setup. */
export const AgentSummary = Schema.Struct(
  Struct.pick(Agent.fields, [
    "id",
    "name",
    "isConversational",
    "creatorUserId",
    "isPublished",
    "status",
  ]),
);
export type AgentSummary = typeof AgentSummary.Type;

const AgentErrors = Schema.Union([Refused, NotFound, AccessDenied]);

/**
 * Every member creates agents. An agent's creator and organization admins read its setup, change
 * it and archive it; only its creator publishes it.
 */
export const Agents = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(AgentSummary), error: AccessDenied }),
  Rpc.make("listModels", { success: AgentModels }),
  Rpc.make("get", { payload: { agentId: StringId }, success: Agent, error: AgentErrors }),
  Rpc.make("archive", { payload: { agentId: StringId }, success: Agent, error: AgentErrors }),
  Rpc.make("create", { payload: SaveAgentRequest, success: Agent, error: AgentErrors }),
  Rpc.make("publish", { payload: { agentId: StringId }, success: Agent, error: AgentErrors }),
  Rpc.make("restore", { payload: { agentId: StringId }, success: Agent, error: AgentErrors }),
  Rpc.make("update", {
    payload: { agentId: StringId, ...SaveAgentRequest.fields },
    success: Agent,
    error: AgentErrors,
  }),
).prefix("agents.");
