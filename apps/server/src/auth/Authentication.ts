import { StringId } from "@t45/contracts/models/primitives";
import { AuthSessionId } from "@t45/contracts/resources/Session";
import { Role, State } from "@t45/contracts/models/User";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import * as ServerConfig from "../config.ts";
import { UserRepository } from "../org/UserRepository.ts";

export class SessionInvalidError extends Schema.TaggedError<SessionInvalidError>()(
  "SessionInvalidError",
  {},
) {
  override get message(): string {
    return "The session is unknown, expired, or revoked.";
  }
}

export class SessionStoreError extends Schema.TaggedError<SessionStoreError>()(
  "SessionStoreError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Session storage failed.";
  }
}

export interface VerifiedClerkIdentity {
  /** The token's `sub`, which is the user id. */
  readonly subject: string;
  /** The verified email claim; the approval queue identifies people by it. */
  readonly email: string;
  /** The optional display name claim. */
  readonly name: string | null;
  readonly imageUrl?: string | null;
}

export class InvalidClerkIdentityToken extends Schema.TaggedError<InvalidClerkIdentityToken>()(
  "InvalidClerkIdentityToken",
  { cause: Schema.Defect() },
) {}

export class ClerkIdentityProviderUnavailable extends Schema.TaggedError<ClerkIdentityProviderUnavailable>()(
  "ClerkIdentityProviderUnavailable",
  { cause: Schema.Defect() },
) {}

const isTokenValidationFailure = (cause: unknown) =>
  cause instanceof errors.JWTClaimValidationFailed ||
  cause instanceof errors.JWTExpired ||
  cause instanceof errors.JOSEAlgNotAllowed ||
  cause instanceof errors.JWSInvalid ||
  cause instanceof errors.JWTInvalid ||
  cause instanceof errors.JWKSNoMatchingKey ||
  cause instanceof errors.JWKSMultipleMatchingKeys ||
  cause instanceof errors.JWSSignatureVerificationFailed;

/** The identity verified by Clerk is deactivated and may not sign in. */
export class UserDeactivatedError extends Schema.TaggedError<UserDeactivatedError>()(
  "UserDeactivatedError",
  { userId: Schema.String },
) {
  override get message(): string {
    return "This account's access has been deactivated.";
  }
}

/** Storage failed while admitting the user or issuing the session. */
class UserAuthInternalError extends Data.TaggedError("UserAuthInternalError")<{
  readonly cause: unknown;
}> {}

interface IdentityProvider {
  /** The Clerk tenant key; signed-out browsers load Clerk with it. */
  readonly publishableKey: string;
  /**
   * When the token carries an `azp` claim it must equal the request origin;
   * Clerk omits the claim when `Origin` was empty or null, and such tokens
   * are accepted. Callers must pass a canonical origin because the
   * comparison is exact string equality.
   */
  readonly verify: (input: {
    readonly token: string;
    readonly authorizedParty?: string;
  }) => Effect.Effect<
    VerifiedClerkIdentity,
    InvalidClerkIdentityToken | ClerkIdentityProviderUnavailable
  >;
}

export const makeIdentityProvider = (input: {
  readonly publishableKey: string;
  readonly issuer: string;
  readonly jwks: JWTVerifyGetKey;
}): IdentityProvider => ({
  publishableKey: input.publishableKey,
  verify: Effect.fnUntraced(function* ({ token, authorizedParty }) {
    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, input.jwks, {
          algorithms: ["RS256"],
          issuer: input.issuer,
          requiredClaims: ["exp", "iss", "sub", "email"],
        }),
      catch: (cause) =>
        isTokenValidationFailure(cause)
          ? new InvalidClerkIdentityToken({ cause })
          : new ClerkIdentityProviderUnavailable({ cause }),
    });
    const invalid = (message: string) =>
      new InvalidClerkIdentityToken({ cause: new Error(message) });
    if (payload.azp !== undefined && payload.azp !== authorizedParty) {
      return yield* invalid("Token authorized party did not match request origin.");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return yield* invalid("Token subject was missing.");
    }
    // The approval queue identifies people by a verified email in Clerk's session token template.
    if (typeof payload.email !== "string" || payload.email.length === 0) {
      return yield* invalid("Token email was missing.");
    }
    if (payload.email_verified !== true) {
      return yield* invalid("Token email was not verified.");
    }
    return {
      subject: payload.sub,
      email: payload.email,
      name:
        typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name : null,
      imageUrl:
        typeof payload.image_url === "string" && isClerkImageUrl(payload.image_url)
          ? payload.image_url
          : null,
    };
  }),
});

const PUBLISHABLE_KEY = /^pk_(?:test|live)_([A-Za-z0-9+/]+={0,2})$/u;

/**
 * Returns the Frontend API URL a Clerk publishable key encodes
 * (`pk_<test|live>_` + base64 of `<host>$`); the server uses it as the token issuer.
 * Throws when the key does not decode to a bare host.
 */
export function clerkFrontendApiUrl(publishableKey: string): string {
  const encoded = PUBLISHABLE_KEY.exec(publishableKey)?.[1];
  let host: string | undefined;
  try {
    host = encoded && globalThis.atob(encoded).replace(/\$$/u, "");
  } catch {
    host = undefined;
  }
  const url = `https://${host}`;
  if (!host || host.includes("/") || !URL.canParse(url)) {
    throw new Error("Invalid Clerk publishable key.");
  }
  return url;
}

const ClerkPublishableKey = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((publishableKey) => {
      try {
        clerkFrontendApiUrl(publishableKey);
      } catch {
        return "Invalid Clerk publishable key.";
      }
    }),
  ),
);

const configuredIdentityProvider = Effect.gen(function* () {
  const publishableKey = yield* Config.schema(ClerkPublishableKey, "AUTH_CLERK_PUBLISHABLE_KEY");
  const issuer = clerkFrontendApiUrl(publishableKey);
  const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer));
  return makeIdentityProvider({ publishableKey, issuer, jwks });
});

/** Only Clerk's public image service is used for account-picture suggestions. */
export const isClerkImageUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "img.clerk.com" &&
    url.username === "" &&
    url.password === "" &&
    url.port === ""
  );
};

const SESSION_TTL = Duration.days(30);

const SessionRow = Schema.Struct({
  sessionId: AuthSessionId,
  userId: StringId,
  role: Role,
  state: State,
  expiresAt: Schema.DateTimeUtcFromString,
});

const RevokedRow = Schema.Struct({ sessionId: AuthSessionId });

export const makeSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const revocations = yield* PubSub.unbounded<AuthSessionId>();

  const sha256 = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(Base64Url.encode));

  // Cookies are scoped by host, not port, so every server that can be live on
  // one hostname (parallel dev servers) needs its own cookie name, or signing in
  // to one signs you out of the others.
  const cookieName = `t45_session_${(yield* sha256(stateDir)).slice(0, 12)}`;

  const insertSession = SqlSchema.void({
    Request: Schema.Struct({
      sessionId: AuthSessionId,
      tokenHash: Schema.String,
      userId: Schema.String,
      expiresAt: Schema.DateTimeUtcFromString,
    }),
    execute: (input) => sql`
      INSERT INTO auth_sessions
        (session_id, token_hash, user_id, expires_at)
      VALUES (${input.sessionId}, ${input.tokenHash}, ${input.userId}, ${input.expiresAt})
    `,
  });

  const findSession = SqlSchema.findOneOption({
    Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.DateTimeUtcFromString }),
    Result: SessionRow,
    execute: ({ tokenHash, now }) => sql`
      SELECT s.session_id AS "sessionId", s.user_id AS "userId", u.role, u.state,
        s.expires_at AS "expiresAt"
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash} AND s.expires_at > ${now}
    `,
  });

  const deleteSession = SqlSchema.findAll({
    Request: Schema.Struct({ userId: Schema.String, sessionId: AuthSessionId }),
    Result: RevokedRow,
    execute: ({ userId, sessionId }) => sql`
      DELETE FROM auth_sessions WHERE session_id = ${sessionId} AND user_id = ${userId}
      RETURNING session_id AS "sessionId"
    `,
  });

  const deleteUserSessions = SqlSchema.findAll({
    Request: Schema.Struct({ userId: Schema.String, except: Schema.String }),
    Result: RevokedRow,
    execute: ({ userId, except }) => sql`
      DELETE FROM auth_sessions WHERE user_id = ${userId} AND session_id != ${except}
      RETURNING session_id AS "sessionId"
    `,
  });

  const toStoreError = Effect.mapError((cause) => new SessionStoreError({ cause }));

  const publishRevoked = (rows: ReadonlyArray<typeof RevokedRow.Type>) =>
    sql
      .afterCommit(
        PubSub.publishAll(
          revocations,
          rows.map((row) => row.sessionId),
        ).pipe(Effect.asVoid),
      )
      .pipe(Effect.as(rows.length));

  const issue = Effect.fnUntraced(function* (input: { readonly userId: string }) {
    const token = Base64Url.encode(yield* crypto.randomBytes(32));
    const sessionId = AuthSessionId.make(yield* crypto.randomUUIDv4());
    const expiresAt = DateTime.addDuration(yield* DateTime.now, SESSION_TTL);
    yield* insertSession({
      sessionId,
      tokenHash: yield* sha256(token),
      userId: input.userId,
      expiresAt,
    });
    return { token, expiresAt };
  }, toStoreError);

  const authenticate = Effect.fnUntraced(function* (token: string) {
    const tokenHash = yield* sha256(token).pipe(toStoreError);
    const session = yield* findSession({ tokenHash, now: yield* DateTime.now }).pipe(toStoreError);
    return yield* Effect.fromOption(session).pipe(
      Effect.mapError(() => new SessionInvalidError({})),
    );
  });

  const revoke = (input: { readonly userId: string; readonly sessionId: AuthSessionId }) =>
    deleteSession(input).pipe(
      Effect.flatMap(publishRevoked),
      Effect.map((count) => count > 0),
      toStoreError,
    );

  const revokeAllForUser = (userId: string, except?: AuthSessionId) =>
    deleteUserSessions({ userId, except: except ?? "" }).pipe(
      Effect.flatMap(publishRevoked),
      toStoreError,
    );

  return {
    cookieName,
    issue,
    authenticate,
    revoke,
    revokeAllForUser,
    subscribeRevocations: PubSub.subscribe(revocations),
  };
});

const toInternalError = (cause: unknown) => new UserAuthInternalError({ cause });

export interface Options {
  readonly identityProvider?: IdentityProvider;
  readonly sessions?: Effect.Success<typeof makeSessions>;
}

export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const identityProvider = options.identityProvider ?? (yield* configuredIdentityProvider);
    const sessions = options.sessions ?? (yield* makeSessions);
    const users = yield* UserRepository;
    const sql = yield* SqlClient.SqlClient;

    const loginFromClerkSession = Effect.fnUntraced(function* (
      input: Parameters<IdentityProvider["verify"]>[0],
    ) {
      const identity = yield* identityProvider.verify(input);

      // Keep admission and issuance atomic with organization membership changes.
      // Token verification above may fetch JWKS, so it stays outside the lock.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const clerkImageUrl = identity.imageUrl ?? null;
            const user =
              (yield* users.get(identity.subject)) ??
              (yield* users.register({
                id: identity.subject,
                email: identity.email,
                displayName: identity.name?.trim() || identity.email.trim() || identity.subject,
                clerkImageUrl,
                createdAt: now,
              }));

            if (user.state === "deactivated") {
              return yield* new UserDeactivatedError({ userId: user.id });
            }

            // Sign-in refreshes the email and Clerk's picture; the name and avatar stay the user's.
            if (user.email !== identity.email || user.clerkImageUrl !== clerkImageUrl) {
              yield* users.update({
                ...user,
                email: identity.email,
                clerkImageUrl,
                updatedAt: now,
              });
            }
            return yield* sessions
              .issue({ userId: user.id })
              .pipe(Effect.mapError(toInternalError));
          }),
        )
        .pipe(Effect.catchTags({ SqlError: toInternalError }));
    });

    return { ...sessions, loginFromClerkSession, publishableKey: identityProvider.publishableKey };
  });
