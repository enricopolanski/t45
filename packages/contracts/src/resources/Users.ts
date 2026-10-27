import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { StringId, NonNegativeInt } from "../models/primitives.ts";
import { Avatar, InvalidAvatar } from "../models/Avatar.ts";
import { DisplayName, Refused, Role, User } from "../models/User.ts";
import { AdminOnly } from "../Authorization.ts";
import { NotFound } from "./errors.ts";

export const UpdateProfileRequest = Schema.Struct({
  displayName: DisplayName,
  avatar: Avatar,
});
export type UpdateProfileRequest = typeof UpdateProfileRequest.Type;

const UserErrors = Schema.Union([Refused, NotFound]);

export const Users = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(User) }),
  Rpc.make("getProfile", { success: User, error: NotFound }),
  Rpc.make("updateProfile", {
    payload: UpdateProfileRequest,
    success: User,
    error: Schema.Union([InvalidAvatar, NotFound]),
  }),
  Rpc.make("approve", {
    payload: { userId: StringId, role: Role },
    success: User,
    error: UserErrors,
  }).middleware(AdminOnly),
  Rpc.make("decline", { payload: { userId: StringId }, error: UserErrors }).middleware(AdminOnly),
  Rpc.make("changeRole", {
    payload: { userId: StringId, role: Role },
    success: User,
    error: UserErrors,
  }).middleware(AdminOnly),
  Rpc.make("deactivate", {
    payload: { userId: StringId },
    success: User,
    error: UserErrors,
  }).middleware(AdminOnly),
  Rpc.make("reactivate", {
    payload: { userId: StringId },
    success: User,
    error: UserErrors,
  }).middleware(AdminOnly),
  Rpc.make("signOutElsewhere", { success: Schema.Struct({ revokedCount: NonNegativeInt }) }),
).prefix("users.");
