import {
  AdminOnly as AdminOnlyMiddleware,
  Authorization as AuthorizationMiddleware,
  CurrentUser,
} from "@t45/contracts/Authorization";
import { AccessDenied } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { RpcSchema } from "effect/rpc";

import { UserService } from "../org/UserService.ts";

const denied = new AccessDenied({ message: "Only active members can use this server." });
const signedOut = new AccessDenied({ message: "This session was signed out." });

export const Authorization = {
  layer: Layer.effect(
    AuthorizationMiddleware,
    Effect.gen(function* () {
      const sessions = yield* UserService;
      const authenticate = (headers: Headers.Headers) =>
        Effect.gen(function* () {
          const cookie = Option.getOrElse(Headers.get(headers, "cookie"), () => "");
          const token = Cookies.parseHeader(cookie)[sessions.cookieName];
          if (token === undefined) return yield* denied;
          const session = yield* sessions.authenticate(token).pipe(
            Effect.catchTags({
              SessionInvalidError: () => denied,
              SessionStoreError: Effect.die,
            }),
          );
          if (session.state !== "active") return yield* denied;
          return session;
        });
      return AuthorizationMiddleware.of((effect, { rpc, headers }) =>
        RpcSchema.isStreamSchema(rpc.successSchema)
          ? Effect.gen(function* () {
              const revoked = yield* sessions.subscribeRevocations;
              const currentUser = yield* authenticate(headers);
              const revocation = PubSub.take(revoked).pipe(
                Effect.repeat({ until: (sessionId) => sessionId === currentUser.sessionId }),
                Effect.andThen(Effect.fail(signedOut)),
              );
              return yield* Effect.raceFirst(
                effect.pipe(Effect.provideService(CurrentUser, currentUser)),
                revocation,
              );
            })
          : authenticate(headers).pipe(
              Effect.flatMap((currentUser) =>
                effect.pipe(Effect.provideService(CurrentUser, currentUser)),
              ),
            ),
      );
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
