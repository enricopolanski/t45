import {
  AdminOnly as AdminOnlyMiddleware,
  Authorization as AuthorizationMiddleware,
  CurrentUser,
  CurrentActor,
} from "@t45/contracts/Authorization";
import { CollectionOperations } from "@t45/contracts/resources/Collections";
import { AccessDenied } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { RpcSchema } from "effect/rpc";

import { ChatService } from "../chats/ChatService.ts";
import { UserService } from "../org/UserService.ts";

/** What an execution token reaches; each operation checks what the agent may do with it. */
const isAgentOperation = (tag: string) =>
  tag.startsWith("workflows.") || tag === "chats.report" || CollectionOperations.requests.has(tag);

const denied = new AccessDenied({ message: "Only active members can use this server." });
const signedOut = new AccessDenied({ message: "This session was signed out." });

export const Authorization = {
  layer: Layer.effect(
    AuthorizationMiddleware,
    Effect.gen(function* () {
      const sessions = yield* UserService;
      const chats = yield* ChatService;
      const authenticate = (headers: Headers.Headers) =>
        Effect.gen(function* () {
          const cookie = Option.getOrElse(Headers.get(headers, "cookie"), () => "");
          const token = Cookies.parseHeader(cookie)[sessions.cookieName];
          if (token === undefined) return yield* denied;
          const session = yield* sessions.authenticate(token).pipe(
            Effect.catchTags({
              SessionInvalidError: () => denied,
            }),
          );
          if (session.state !== "active") return yield* denied;
          return session;
        });
      return AuthorizationMiddleware.of((effect, { rpc, headers }) => {
        if (headers.authorization !== undefined) {
          if (!isAgentOperation(rpc._tag)) return Effect.fail(denied);
          return chats.authenticateAgent(headers.authorization.replace(/^Bearer /, "")).pipe(
            Effect.catchTags({ NotFound: () => Effect.fail(denied) }),
            Effect.flatMap((actor) => Effect.provideService(effect, CurrentActor, actor)),
          );
        }
        return RpcSchema.isStreamSchema(rpc.successSchema)
          ? Effect.gen(function* () {
              // Held streams keep their initial authorization; subscribe before authenticating
              // so a concurrent revocation cannot be missed.
              const revoked = yield* sessions.subscribeRevocations;
              const currentUser = yield* authenticate(headers);
              const revocation = PubSub.take(revoked).pipe(
                Effect.repeat({ until: (sessionId) => sessionId === currentUser.sessionId }),
                Effect.andThen(Effect.fail(signedOut)),
              );
              return yield* Effect.raceFirst(
                effect.pipe(Effect.provideService(CurrentActor, currentUser)),
                revocation,
              );
            })
          : authenticate(headers).pipe(
              Effect.flatMap((currentUser) =>
                effect.pipe(Effect.provideService(CurrentActor, currentUser)),
              ),
            );
      });
    }),
  ),
};

export const AdminOnly = {
  layer: Layer.succeed(
    AdminOnlyMiddleware,
    AdminOnlyMiddleware.of((effect) =>
      Effect.flatMap(CurrentUser, (currentUser) =>
        currentUser.role === "admin"
          ? effect
          : Effect.fail(new AccessDenied({ message: "Only admins can do that." })),
      ),
    ),
  ),
};
