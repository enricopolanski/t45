import * as Context from "effect/Context";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

import { StringId } from "./models/primitives.ts";
import type { Role, State } from "./models/User.ts";
import { AccessDenied } from "./resources/errors.ts";
import type { AuthSessionId } from "./resources/Session.ts";

export class CurrentUser extends Context.Service<
  CurrentUser,
  {
    readonly sessionId: AuthSessionId;
    readonly userId: StringId;
    readonly role: Role;
    readonly state: State;
  }
>()("@t45/contracts/Authorization/CurrentUser") {}

/**
 * Rejects every RPC from a session whose user is not an active member, such as
 * a registration still awaiting approval, before the handler runs. Its error is
 * part of every RPC's error type.
 */
export class Authorization extends RpcMiddleware.Service<
  Authorization,
  { provides: CurrentUser }
>()("t45/contracts/Authorization", { error: AccessDenied }) {}

export class AdminOnly extends RpcMiddleware.Service<AdminOnly, { requires: CurrentUser }>()(
  "t45/contracts/AdminOnly",
  { error: AccessDenied },
) {}
