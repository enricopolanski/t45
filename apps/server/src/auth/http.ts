import { TrimmedNonEmptyString } from "@t45/contracts/models/primitives";
import { type AuthFailure, AuthSessionState } from "@t45/contracts/resources/Session";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { UserService } from "../org/UserService.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const SESSION_COOKIE_OPTIONS = { httpOnly: true, path: "/", sameSite: "lax" } as const;

const AUTH_FAILURE_STATUS = {
  invalid_credential: 401,
  deactivated: 403,
  unauthenticated: 401,
  inactive: 403,
  internal_error: 500,
} satisfies Record<AuthFailure["error"], number>;

const refuse = (error: AuthFailure["error"]) =>
  HttpServerResponse.jsonUnsafe({ error } satisfies AuthFailure, {
    status: AUTH_FAILURE_STATUS[error],
  });

const failed = (cause: unknown) =>
  Effect.logError("auth request failed", { cause }).pipe(Effect.as(refuse("internal_error")));

const deployVersion = process.env.BUILD_SHA || "development";

const readSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessions = yield* UserService;
  const token = request.cookies[sessions.cookieName];
  if (!token) return null;
  return yield* sessions
    .authenticate(token)
    .pipe(Effect.catchTags({ SessionInvalidError: () => Effect.succeed(null) }));
});

const signedIn = readSession.pipe(
  Effect.map((session) => session ?? refuse("unauthenticated")),
  Effect.catchTags({ SessionStoreError: failed }),
);

/** Authenticates a raw route's request and requires an active member, like the RPC middleware. */
export const member = signedIn.pipe(
  Effect.map((session) =>
    HttpServerResponse.isHttpServerResponse(session) || session.state === "active"
      ? session
      : refuse("inactive"),
  ),
);

const sessionRoute = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const session = yield* readSession;
    return yield* HttpServerResponse.schemaJson(AuthSessionState)(
      session === null
        ? {
            isAuthenticated: false,
            // What signed-out browsers need to sign in.
            clerkPublishableKey: (yield* UserService).publishableKey,
            deployVersion,
          }
        : {
            isAuthenticated: true,
            userId: session.userId,
            role: session.role,
            state: session.state,
            deployVersion,
          },
    );
  }).pipe(Effect.catchTags({ SessionStoreError: failed, HttpBodyError: failed })),
);

const clerkSessionRoute = HttpRouter.add(
  "POST",
  "/api/auth/clerk-session",
  Effect.gen(function* () {
    const token = yield* HttpServerRequest.schemaBodyJson(TrimmedNonEmptyString).pipe(
      Effect.option,
    );
    if (Option.isNone(token)) return refuse("invalid_credential");
    const origin = (yield* HttpServerRequest.HttpServerRequest).headers.origin;
    const sessions = yield* UserService;
    return yield* sessions
      .loginFromClerkSession({
        token: token.value,
        ...(origin === undefined ? {} : { authorizedParty: origin }),
      })
      .pipe(
        Effect.flatMap((login) =>
          HttpServerResponse.setCookie(
            HttpServerResponse.empty({ headers: CREDENTIAL_RESPONSE_HEADERS }),
            sessions.cookieName,
            login.token,
            { ...SESSION_COOKIE_OPTIONS, expires: DateTime.toDate(login.expiresAt) },
          ),
        ),
        Effect.catchTags({
          InvalidClerkIdentityToken: () => Effect.succeed(refuse("invalid_credential")),
          UserDeactivatedError: () => Effect.succeed(refuse("deactivated")),
          ClerkIdentityProviderUnavailable: failed,
          UserAuthInternalError: failed,
          CookiesError: failed,
        }),
      );
  }),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/api/auth/logout",
  Effect.gen(function* () {
    const session = yield* signedIn;
    if (HttpServerResponse.isHttpServerResponse(session)) return session;
    const sessions = yield* UserService;
    return yield* sessions
      .revoke({ userId: session.userId, sessionId: session.sessionId })
      .pipe(
        Effect.andThen(
          HttpServerResponse.expireCookie(
            HttpServerResponse.empty({ headers: CREDENTIAL_RESPONSE_HEADERS }),
            sessions.cookieName,
            SESSION_COOKIE_OPTIONS,
          ),
        ),
        Effect.catchTags({ SessionStoreError: failed, CookiesError: failed }),
      );
  }),
);

export const layer = Layer.mergeAll(sessionRoute, clerkSessionRoute, logoutRoute);
