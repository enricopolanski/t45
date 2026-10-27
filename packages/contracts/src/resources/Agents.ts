import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Agent, AgentModel, Refused } from "../models/Agent.ts";
import { StringId } from "../models/primitives.ts";
import { AdminOnly } from "../Authorization.ts";
import { NotFound } from "./errors.ts";

class SaveAgentRequest extends Schema.Opaque<SaveAgentRequest>()(
  Schema.Struct(
    Struct.pick(Agent.fields, [
      "name",
      "instructions",
      "model",
      "files",
      "skills",
      "mcpServers",
      "permissions",
      "isConversational",
    ]),
  ),
) {}

export class AgentModels extends Schema.Opaque<AgentModels>()(
  Schema.Struct({ models: Schema.Array(AgentModel), reason: Schema.NullOr(Schema.String) }),
) {}

export const Agents = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(Agent) }),
  Rpc.make("listModels", { success: AgentModels }).middleware(AdminOnly),
  Rpc.make("get", { payload: { agentId: StringId }, success: Agent, error: NotFound }).middleware(
    AdminOnly,
  ),
  Rpc.make("archive", {
    payload: { agentId: StringId },
    success: Agent,
    error: NotFound,
  }).middleware(AdminOnly),
  Rpc.make("create", {
    payload: SaveAgentRequest,
    success: Agent,
    error: Refused,
  }).middleware(AdminOnly),
  Rpc.make("restore", {
    payload: { agentId: StringId },
    success: Agent,
    error: Schema.Union([Refused, NotFound]),
  }).middleware(AdminOnly),
  Rpc.make("update", {
    payload: { agentId: StringId, ...SaveAgentRequest.fields },
    success: Agent,
    error: Schema.Union([Refused, NotFound]),
  }).middleware(AdminOnly),
).prefix("agents.");
