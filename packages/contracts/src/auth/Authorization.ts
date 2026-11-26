import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import type { ChatId } from "../models/Chat.ts";
import type { ChatOrigin } from "../models/ChatOrigin.ts";
import { makeId } from "../models/primitives.ts";
import type { Role, State } from "../models/User.ts";

export const AuthSessionId = makeId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;

export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
  message: Schema.String,
}) {}

/** Identity supplied by authentication: a member session or an executing agent and its origin. */
export class CurrentActor extends Context.Service<
  CurrentActor,
  | {
      readonly sessionId: AuthSessionId;
      readonly userId: string;
      readonly role: Role;
      readonly state: State;
    }
  | { readonly chatId: ChatId; readonly agentId: string; readonly origin: ChatOrigin }
>()("@t45/contracts/auth/Authorization/CurrentActor") {}

export const CurrentUser = CurrentActor.pipe(
  Effect.filterOrFail(
    (actor): actor is Extract<CurrentActor["Service"], { userId: string }> => "userId" in actor,
    () => new AccessDenied({ message: "This operation requires a member." }),
  ),
);

/** Authenticates a member session or an agent execution token. */
export class Authorization extends RpcMiddleware.Service<
  Authorization,
  { provides: CurrentActor }
>()("t45/contracts/Authorization", { error: AccessDenied }) {}

export class AdminOnly extends RpcMiddleware.Service<AdminOnly, { requires: CurrentActor }>()(
  "t45/contracts/AdminOnly",
  { error: AccessDenied },
) {}
