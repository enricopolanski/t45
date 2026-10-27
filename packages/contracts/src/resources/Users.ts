import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { StringId, NonNegativeInt } from "../models/primitives.ts";
import { AvatarColor, DisplayName, MAX_AVATAR_BYTES, Refused, Role, User } from "../models/User.ts";
import { AdminOnly } from "../Authorization.ts";
import { NotFound } from "./errors.ts";

export const UpdateProfileRequest = Schema.Struct({
  displayName: DisplayName,
  avatar: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("keep") }),
    Schema.Struct({ kind: Schema.Literal("initial"), color: AvatarColor }),
    Schema.Struct({
      kind: Schema.Literal("upload"),
      contentType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
      data: Schema.String.check(Schema.isMaxLength(Math.ceil(MAX_AVATAR_BYTES / 3) * 4)),
    }),
  ]),
});
export type UpdateProfileRequest = typeof UpdateProfileRequest.Type;

const UserErrors = Schema.Union([Refused, NotFound]);

export const Users = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(User) }),
  Rpc.make("getProfile", { success: User, error: NotFound }),
  Rpc.make("updateProfile", {
    payload: UpdateProfileRequest,
    success: User,
    error: Schema.Union([Refused, NotFound]),
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
