import * as Schema from "effect/Schema";

import { StringId, makeId, TrimmedNonEmptyString } from "../models/primitives.ts";
import { Role, State } from "../models/User.ts";

export const AuthSessionId = makeId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;

/** Git commit baked into the running server, or "development" in source mode. */
const DeployVersion = TrimmedNonEmptyString;

export const AuthSessionState = Schema.Union([
  Schema.Struct({
    isAuthenticated: Schema.Literal(false),
    clerkPublishableKey: TrimmedNonEmptyString,
    deployVersion: DeployVersion,
  }),
  Schema.Struct({
    isAuthenticated: Schema.Literal(true),
    userId: StringId,
    role: Role,
    state: State,
    deployVersion: DeployVersion,
  }),
]);
export type AuthSessionState = typeof AuthSessionState.Type;

export const AuthFailure = Schema.Struct({
  error: Schema.Literals([
    "invalid_credential",
    "deactivated",
    "unauthenticated",
    "inactive",
    "internal_error",
  ]),
});
export type AuthFailure = typeof AuthFailure.Type;
