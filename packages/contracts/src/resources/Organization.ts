import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { Avatar, InvalidAvatar } from "../models/Avatar.ts";
import { Organization as OrganizationModel } from "../models/Organization.ts";
import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { AdminOnly } from "../Authorization.ts";

export const UpdateOrganizationRequest = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  avatar: Avatar,
});
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type;

export const Organization = RpcGroup.make(
  Rpc.make("get", { success: OrganizationModel }),
  Rpc.make("update", {
    payload: UpdateOrganizationRequest,
    success: OrganizationModel,
    error: InvalidAvatar,
  }).middleware(AdminOnly),
).prefix("organization.");
