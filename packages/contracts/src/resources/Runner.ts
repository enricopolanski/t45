import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { ChatId } from "../models/Chat.ts";
import { RunnerInventory } from "./RunnerVms.ts";
import { AdminOnly } from "../Authorization.ts";

export class RunnerStatus extends Schema.Opaque<RunnerStatus>()(
  Schema.Struct({
    isAvailable: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    /** The VMs the runner has seen since it started, with each one's chat. */
    vms: Schema.Array(
      Schema.Struct({
        ...RunnerInventory.fields.vms.value.fields,
        /** Null for a VM T45 holds no chat for, or for a chat the current user may not open. */
        chat: Schema.NullOr(
          Schema.Struct({
            id: ChatId,
            title: Schema.String,
            agentName: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  }),
) {}

export const Runner = RpcGroup.make(Rpc.make("get", { success: RunnerStatus }))
  .prefix("runner.")
  .middleware(AdminOnly);
