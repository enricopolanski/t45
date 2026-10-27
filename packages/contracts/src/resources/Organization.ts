import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { Organization as OrganizationModel } from "../models/Organization.ts";
import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { AdminOnly } from "../Authorization.ts";

export const Organization = RpcGroup.make(
  Rpc.make("get", { success: OrganizationModel }),
  Rpc.make("rename", {
    payload: { name: TrimmedNonEmptyString },
    success: OrganizationModel,
  }).middleware(AdminOnly),
).prefix("organization.");
