import * as Schema from "effect/Schema";

import { Avatar } from "./Avatar.ts";
import { StringId, TrimmedNonEmptyString } from "./primitives.ts";

/** Admins manage the organization and its users. */
export const Role = Schema.Literals(["admin", "member"]);
export type Role = typeof Role.Type;

/** Pending users await approval; deactivation is reversible. */
export const State = Schema.Literals(["pending", "active", "deactivated"]);
export type State = typeof State.Type;

/** A name chosen in the profile editor; Clerk's initial suggestion may be longer. */
export const DisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** One Clerk identity in this deployment, including its access and chosen profile. */
export class User extends Schema.Opaque<User>()(
  Schema.Struct({
    id: StringId,
    email: Schema.String,
    displayName: TrimmedNonEmptyString,
    role: Role,
    state: State,
    avatar: Avatar,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

export const canManageUsers = (user: Pick<User, "role" | "state">) =>
  user.state === "active" && user.role === "admin";

const stateRefusal = (user: Pick<User, "state">, state: State) =>
  user.state === state ? null : ("invalid_member_state" as const);

export const pendingRequestRefusal = (user: Pick<User, "state">) => stateRefusal(user, "pending");
export const activeUserRefusal = (user: Pick<User, "state">) => stateRefusal(user, "active");
export const reactivationRefusal = (user: Pick<User, "state">) => stateRefusal(user, "deactivated");

/** The organization must keep another active admin before this one loses access or their role. */
export const lastAdminRefusal = (
  users: ReadonlyArray<Pick<User, "id" | "role" | "state">>,
  target: Pick<User, "id" | "role" | "state">,
) =>
  canManageUsers(target) && !users.some((user) => user.id !== target.id && canManageUsers(user))
    ? ("last_admin_protected" as const)
    : null;

export class Refused extends Schema.TaggedError<Refused>()("UserRefused", {
  reason: Schema.Literals(["invalid_member_state", "last_admin_protected", "last_workflow_admin"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_member_state":
        return "This user's state does not allow this action.";
      case "last_admin_protected":
        return "An organization must keep at least one active admin.";
      case "last_workflow_admin":
        return "They are the last active admin of a workflow. Make someone else its admin first.";
    }
  }
}
