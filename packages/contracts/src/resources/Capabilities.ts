import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { AdminOnly } from "../Authorization.ts";
import { Capability } from "../models/Capability.ts";
import { StringId } from "../models/primitives.ts";
import { NotFound } from "./errors.ts";

export const Capabilities = RpcGroup.make(
  Rpc.make("import", { payload: { capabilities: Schema.Array(Capability) } }),
)
  .middleware(AdminOnly)
  .add(
    Rpc.make("list", { success: Schema.Array(Capability) }),
    Rpc.make("get", {
      payload: { capabilityId: StringId },
      success: Capability,
      error: NotFound,
    }),
  )
  .prefix("capabilities.");
