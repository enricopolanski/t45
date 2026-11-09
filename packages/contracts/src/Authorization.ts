import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import type { ChatId } from "./models/Chat.ts";
import type { ChatOrigin } from "./models/ChatOrigin.ts";
import type { Role, State } from "./models/User.ts";
import { AccessDenied } from "./resources/errors.ts";
import type { AuthSessionId } from "./resources/Session.ts";

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
>()("@t45/contracts/Authorization/CurrentActor") {}

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
