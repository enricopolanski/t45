import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { Refused, type User } from "@t45/contracts/models/User";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Users } from "@t45/contracts/resources/Users";
import type { NotFound } from "@t45/contracts/resources/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from "jose";

import { AdminOnly } from "../auth/Authorization.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UserRepository from "./UserRepository.ts";
import { UserService } from "./UserService.ts";
import * as Authentication from "../auth/Authentication.ts";
import type { VerifiedClerkIdentity } from "../auth/Authentication.ts";
import * as UsersHandlers from "./Users.handlers.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";

describe("UserService", () => {
  describe("Clerk identity", () => {
    const publishableKey = "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==";
    const issuer = "https://clerk.example.test";
    const authorizedParty = "https://app.example.test";

    const makeToken = async (input: {
      readonly privateKey: CryptoKey;
      readonly issuer?: string;
      /** `null` omits the `azp` claim, as Clerk does when the request had no `Origin`. */
      readonly authorizedParty?: string | null;
      readonly expirationTime?: string | null;
      readonly subject?: string;
      /** `null` omits the `email` claim. */
      readonly email?: string | null;
      /** `null` omits the `email_verified` claim. */
      readonly emailVerified?: boolean | null;
      readonly name?: string;
    }) => {
      const azp =
        input.authorizedParty === null ? undefined : (input.authorizedParty ?? authorizedParty);
      const email = input.email === null ? undefined : (input.email ?? "user@example.test");
      const emailVerified =
        input.emailVerified === null ? undefined : (input.emailVerified ?? true);
      const payload = {
        ...(azp === undefined ? {} : { azp }),
        ...(email === undefined ? {} : { email }),
        ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      const token = new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(input.issuer ?? issuer)
        .setSubject(input.subject ?? "user_123")
        .setIssuedAt();

      if (input.expirationTime !== null) {
        token.setExpirationTime(input.expirationTime ?? "1 hour");
      }

      return token.sign(input.privateKey);
    };

    let signingKeys: ReturnType<typeof generateKeyPair> | undefined;

    const makeProvider = async () => {
      const keyPair = await (signingKeys ??= generateKeyPair("RS256"));
      const publicJwk = await exportJWK(keyPair.publicKey);
      return {
        keyPair,
        provider: Authentication.makeIdentityProvider({
          publishableKey,
          issuer,
          jwks: createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", kid: "test-key" }] }),
        }),
      };
    };

    it.effect("ClerkIdentityProvider verifies a session and extracts its identity", () =>
      Effect.gen(function* () {
        const { keyPair, provider } = yield* Effect.promise(makeProvider);
        const token = yield* Effect.promise(() =>
          makeToken({ privateKey: keyPair.privateKey, name: "Ada Lovelace" }),
        );

        assert.deepStrictEqual(yield* provider.verify({ token, authorizedParty }), {
          subject: "user_123",
          email: "user@example.test",
          name: "Ada Lovelace",
        });
      }),
    );

    it.effect("ClerkIdentityProvider accepts a token without an azp claim", () =>
      Effect.gen(function* () {
        const { keyPair, provider } = yield* Effect.promise(makeProvider);
        const token = yield* Effect.promise(() =>
          makeToken({ privateKey: keyPair.privateKey, authorizedParty: null }),
        );

        const expected = {
          subject: "user_123",
          email: "user@example.test",
          name: null,
        };
        assert.deepStrictEqual(yield* provider.verify({ token, authorizedParty }), expected);
        assert.deepStrictEqual(yield* provider.verify({ token }), expected);
      }),
    );

    it.effect("ClerkIdentityProvider rejects tokens without a verified email", () =>
      Effect.gen(function* () {
        const { keyPair, provider } = yield* Effect.promise(makeProvider);
        const tokens = yield* Effect.promise(() =>
          Promise.all([
            makeToken({ privateKey: keyPair.privateKey, email: null }),
            makeToken({ privateKey: keyPair.privateKey, email: "" }),
            makeToken({ privateKey: keyPair.privateKey, emailVerified: false }),
            makeToken({ privateKey: keyPair.privateKey, emailVerified: null }),
          ]),
        );

        for (const token of tokens) {
          const error = yield* Effect.flip(provider.verify({ token, authorizedParty }));
          assert.instanceOf(error, Authentication.InvalidClerkIdentityToken);
        }
      }),
    );

    it.effect("ClerkIdentityProvider rejects an azp-bearing token without a request origin", () =>
      Effect.gen(function* () {
        const { keyPair, provider } = yield* Effect.promise(makeProvider);
        const token = yield* Effect.promise(() => makeToken({ privateKey: keyPair.privateKey }));

        const error = yield* Effect.flip(provider.verify({ token }));
        assert.instanceOf(error, Authentication.InvalidClerkIdentityToken);
      }),
    );

    it.effect.each([
      { name: "expired", claims: { expirationTime: "0 seconds" } },
      { name: "missing-expiry", claims: { expirationTime: null } },
      { name: "empty-subject", claims: { subject: "" } },
      { name: "wrong-issuer", claims: { issuer: "https://other.clerk.test" } },
      { name: "wrong-party", claims: { authorizedParty: "https://other.example.test" } },
    ] as const)("ClerkIdentityProvider rejects $name tokens", ({ claims }) =>
      Effect.gen(function* () {
        const { keyPair, provider } = yield* Effect.promise(makeProvider);
        const token = yield* Effect.promise(() =>
          makeToken({ privateKey: keyPair.privateKey, ...claims }),
        );

        const error = yield* Effect.flip(provider.verify({ token, authorizedParty }));
        assert.instanceOf(error, Authentication.InvalidClerkIdentityToken);
      }),
    );

    it.effect("ClerkIdentityProvider rejects invalid-signature tokens", () =>
      Effect.gen(function* () {
        const { provider } = yield* Effect.promise(makeProvider);
        const otherKeyPair = yield* Effect.promise(() => generateKeyPair("RS256"));
        const token = yield* Effect.promise(() =>
          makeToken({ privateKey: otherKeyPair.privateKey }),
        );

        const error = yield* Effect.flip(provider.verify({ token, authorizedParty }));
        assert.instanceOf(error, Authentication.InvalidClerkIdentityToken);
      }),
    );

    it.effect("ClerkIdentityProvider reports a JWKS outage as unavailable", () =>
      Effect.gen(function* () {
        const { keyPair } = yield* Effect.promise(makeProvider);
        const token = yield* Effect.promise(() => makeToken({ privateKey: keyPair.privateKey }));

        const provider = Authentication.makeIdentityProvider({
          publishableKey,
          issuer,
          jwks: () => Promise.reject(new errors.JWKSTimeout()),
        });
        const error = yield* Effect.flip(provider.verify({ token, authorizedParty }));
        assert.instanceOf(error, Authentication.ClerkIdentityProviderUnavailable);
      }),
    );
  });

  it.layer(NodeServices.layer)("Sign-in", (it) => {
    const identity: VerifiedClerkIdentity = {
      subject: "user_123",
      email: "user@example.test",
      name: "Ada Lovelace",
      imageUrl: "https://img.clerk.com/ada.png",
    };
    const at = DateTime.makeUnsafe("2026-01-02T00:00:00Z");
    const login = UserService.use((auth) =>
      auth.loginFromClerkSession({ token: identity.subject }),
    );
    const layer = (
      verify: ReturnType<typeof Authentication.makeIdentityProvider>["verify"] = ({ token }) =>
        Effect.succeed({ ...identity, subject: token }),
    ) =>
      Layer.effect(UserService, UserService.make).pipe(
        Layer.provide(
          Layer.succeed(Authentication.IdentityProvider, {
            publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
            verify,
          }),
        ),
        Layer.provideMerge(UserRepository.layer),
        Layer.provideMerge(SqlitePersistence.layerTest),
        Layer.provide(ServerConfig.layerTest({ prefix: "t3-user-auth-" })),
      );

    /** The identity as an earlier sign-in registered it, with `changes` made since. */
    const registered = (changes: Partial<User> = {}, upload?: Uint8Array) =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        const user = yield* users.register({
          id: identity.subject,
          email: "old@example.test",
          displayName: "Kept name",
          createdAt: at,
        });
        yield* users.update({ ...user, ...changes }, upload);
      });

    it.effect(
      "registers the first admin and later pending members, preserving existing membership",
      () =>
        Effect.gen(function* () {
          const auth = yield* UserService;
          const users = yield* UserRepository.UserRepository;
          const sessions = yield* UserService;
          const first = yield* login;
          const admin = yield* sessions.authenticate(first.token);
          assert.deepStrictEqual(
            [admin.userId, admin.role, admin.state],
            [identity.subject, "admin", "active"],
          );
          const pending = yield* auth.loginFromClerkSession({ token: "another-user" });
          const member = yield* sessions.authenticate(pending.token);
          assert.deepStrictEqual(
            [member.userId, member.role, member.state],
            ["another-user", "member", "pending"],
          );
          const approved = yield* users.get(member.userId);
          if (approved !== null) yield* users.update({ ...approved, state: "active" });
          const again = yield* auth.loginFromClerkSession({ token: member.userId });
          const active = yield* sessions.authenticate(again.token);
          assert.deepStrictEqual([active.role, active.state], ["member", "active"]);
          assert.strictEqual((yield* users.list).length, 2);
        }).pipe(Effect.provide(layer())),
    );

    it.effect.each([
      {
        title: "names a new user after Clerk's name",
        name: " Ada Lovelace ",
        expected: "Ada Lovelace",
      },
      {
        title: "names a new user without one after their email",
        name: null,
        expected: identity.email,
      },
    ])("$title", (scenario) =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        yield* login;
        assert.strictEqual((yield* users.get(identity.subject))?.displayName, scenario.expected);
      }).pipe(Effect.provide(layer(() => Effect.succeed({ ...identity, name: scenario.name })))),
    );

    it.effect.each([
      {
        title: "preserves the stored name when Clerk changes its suggestion",
        name: identity.name,
        edited: false,
        expected: "Kept name",
      },
      {
        title: "keeps the stored name when the token has none",
        name: null,
        edited: false,
        expected: "Kept name",
      },
      {
        title: "preserves an edited name and avatar across sign-ins",
        name: identity.name,
        edited: true,
        expected: "Chosen name",
      },
    ])("$title, refreshing the email and Clerk's picture", (scenario) =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        const sessions = yield* UserService;
        const image = new Uint8Array([1, 2, 3]);
        if (scenario.edited) {
          yield* registered(
            { displayName: "Chosen name", avatar: { kind: "image", url: "/chosen.png" } },
            image,
          );
        } else {
          yield* registered();
        }
        const signedIn = yield* login;
        assert.strictEqual((yield* sessions.authenticate(signedIn.token)).userId, identity.subject);
        const stored = yield* users.get(identity.subject);
        assert.deepStrictEqual(
          [stored?.email, stored?.displayName],
          [identity.email, scenario.expected],
        );
        if (scenario.edited) {
          assert.strictEqual(stored?.avatar.kind, "image");
          assert.deepStrictEqual(yield* users.avatarImage(identity.subject), image);
        }
      }).pipe(Effect.provide(layer(() => Effect.succeed({ ...identity, name: scenario.name })))),
    );

    it.effect(
      "refuses a deactivated member without changing their profile or issuing a session",
      () =>
        Effect.gen(function* () {
          const users = yield* UserRepository.UserRepository;
          const sql = yield* SqlClient.SqlClient;
          yield* registered({ state: "deactivated" });
          assert.instanceOf(yield* Effect.flip(login), Authentication.UserDeactivatedError);
          assert.strictEqual((yield* users.get(identity.subject))?.email, "old@example.test");
          assert.deepStrictEqual(yield* sql`SELECT user_id FROM auth_sessions`, []);
        }).pipe(Effect.provide(layer())),
    );

    it.effect.each([
      new Authentication.InvalidClerkIdentityToken({ cause: new Error("expired") }),
      new Authentication.ClerkIdentityProviderUnavailable({ cause: new Error("jwks") }),
    ])("preserves $_tag without registering or signing in", (error) =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        assert.strictEqual((yield* Effect.flip(login))._tag, error._tag);
        assert.deepStrictEqual(yield* users.list, []);
      }).pipe(Effect.provide(layer(() => Effect.fail(error)))),
    );
  });

  it.layer(NodeServices.layer)("Sessions", (it) => {
    const insertUser = (id: string, state: "active" | "pending") =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO users (id, role, state, email, display_name, created_at, updated_at)
          VALUES (${id}, 'member', ${state}, ${`${id}@example.test`}, ${id}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
      });

    const layerSessionStore = (stateDirPrefix = "t3-session-store-") =>
      Layer.effect(UserService, UserService.make).pipe(
        Layer.provide(
          Layer.succeed(Authentication.IdentityProvider, {
            publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
            verify: ({ token }) =>
              Effect.succeed({ subject: token, email: `${token}@example.test`, name: token }),
          }),
        ),
        Layer.provideMerge(UserRepository.layer),
        Layer.provideMerge(SqlitePersistence.layerTest),
        Layer.provide(ServerConfig.layerTest({ prefix: stateDirPrefix })),
      );

    it.effect("authenticates a token with the user's current role and state", () =>
      Effect.gen(function* () {
        const sessions = yield* UserService;
        const sql = yield* SqlClient.SqlClient;
        yield* insertUser("user-ada", "pending");
        const { token } = yield* sessions.issue({ userId: "user-ada" });

        expect(yield* sessions.authenticate(token)).toMatchObject({
          userId: "user-ada",
          role: "member",
          state: "pending",
        });
        yield* sql`UPDATE users SET state = 'active', role = 'admin' WHERE id = 'user-ada'`;
        expect(yield* sessions.authenticate(token)).toMatchObject({
          role: "admin",
          state: "active",
        });
      }).pipe(Effect.provide(layerSessionStore())),
    );

    it.effect("refuses unknown tokens and expired sessions", () =>
      Effect.gen(function* () {
        const sessions = yield* UserService;
        yield* insertUser("user-ada", "active");
        const { token } = yield* sessions.issue({ userId: "user-ada" });

        const unknown = yield* Effect.flip(sessions.authenticate(`${token}x`));
        expect(unknown._tag).toBe("SessionInvalidError");

        yield* TestClock.adjust("31 days");
        const expired = yield* Effect.flip(sessions.authenticate(token));
        expect(expired._tag).toBe("SessionInvalidError");
      }).pipe(Effect.provide(layerSessionStore())),
    );

    it.effect("signs out elsewhere while keeping this session and other users signed in", () =>
      Effect.gen(function* () {
        const sessions = yield* UserService;
        const sql = yield* SqlClient.SqlClient;
        yield* insertUser("user-ada", "active");
        yield* insertUser("user-bob", "active");
        const revoked = yield* sessions.subscribeRevocations;
        const current = yield* sessions.issue({ userId: "user-ada" });
        const other = yield* sessions.issue({ userId: "user-ada" });
        const another = yield* sessions.issue({ userId: "user-ada" });
        const bobs = yield* sessions.issue({ userId: "user-bob" });
        const currentSession = yield* sessions.authenticate(current.token);
        const otherSession = yield* sessions.authenticate(other.token);
        const anotherSession = yield* sessions.authenticate(another.token);

        yield* sql.withTransaction(
          Effect.gen(function* () {
            expect(yield* sessions.revokeAllForUser("user-ada", currentSession.sessionId)).toBe(2);
            expect(yield* PubSub.takeUpTo(revoked, 1)).toEqual([]);
          }),
        );
        expect(yield* sessions.revokeAllForUser("user-ada", currentSession.sessionId)).toBe(0);
        expect((yield* sessions.authenticate(current.token)).userId).toBe("user-ada");
        expect((yield* sessions.authenticate(bobs.token)).userId).toBe("user-bob");
        expect((yield* Effect.flip(sessions.authenticate(other.token)))._tag).toBe(
          "SessionInvalidError",
        );
        expect((yield* Effect.flip(sessions.authenticate(another.token)))._tag).toBe(
          "SessionInvalidError",
        );
        expect(new Set(yield* PubSub.takeAll(revoked))).toEqual(
          new Set([otherSession.sessionId, anotherSession.sessionId]),
        );

        expect(yield* sessions.revokeAllForUser("user-ada")).toBe(1);
        expect((yield* Effect.flip(sessions.authenticate(current.token)))._tag).toBe(
          "SessionInvalidError",
        );
        expect((yield* sessions.authenticate(bobs.token)).userId).toBe("user-bob");
      }).pipe(Effect.provide(layerSessionStore())),
    );

    it.effect("signs out the current session without affecting other sessions", () =>
      Effect.gen(function* () {
        const sessions = yield* UserService;
        yield* insertUser("user-ada", "active");
        yield* insertUser("user-bob", "active");
        const current = yield* sessions.issue({ userId: "user-ada" });
        const other = yield* sessions.issue({ userId: "user-ada" });
        const bobs = yield* sessions.issue({ userId: "user-bob" });
        const currentSession = yield* sessions.authenticate(current.token);
        const bobSession = yield* sessions.authenticate(bobs.token);
        const revoked = yield* sessions.subscribeRevocations;

        expect(
          yield* sessions.revoke({ userId: "user-ada", sessionId: bobSession.sessionId }),
        ).toBe(false);
        expect(
          yield* sessions.revoke({ userId: "user-ada", sessionId: currentSession.sessionId }),
        ).toBe(true);
        expect((yield* Effect.flip(sessions.authenticate(current.token)))._tag).toBe(
          "SessionInvalidError",
        );
        expect((yield* sessions.authenticate(other.token)).userId).toBe("user-ada");
        expect((yield* sessions.authenticate(bobs.token)).userId).toBe("user-bob");
        expect(yield* PubSub.takeAll(revoked)).toEqual([currentSession.sessionId]);
      }).pipe(Effect.provide(layerSessionStore())),
    );

    it.effect("names the cookie after the server's state directory", () =>
      Effect.gen(function* () {
        const cookieName = (prefix: string) =>
          UserService.pipe(
            Effect.map((sessions) => sessions.cookieName),
            Effect.provide(layerSessionStore(prefix)),
          );
        const one = yield* cookieName("t3-session-one-");
        const two = yield* cookieName("t3-session-two-");
        expect(one).toMatch(/^t45_session_[\w-]{12}$/);
        expect(one).not.toBe(two);
      }),
    );
  });

  it.layer(NodeServices.layer)("Membership and profiles", (it) => {
    const createdAt = DateTime.makeUnsafe("2026-09-21T12:00:00.000Z");
    const adminId = "user_admin";
    const secondAdminId = "user_second_admin";
    const memberId = "user_member";
    const otherId = "user_other";

    function makeHarness(input?: {
      /** Yields after every user read, so a change that isn't one transaction would interleave. */
      readonly yieldAfterReads?: boolean;
    }) {
      const layerUsers = input?.yieldAfterReads
        ? Layer.effect(
            UserRepository.UserRepository,
            Effect.gen(function* () {
              const users = yield* UserRepository.UserRepository;
              return UserRepository.UserRepository.of({
                ...users,
                list: users.list.pipe(Effect.tap(() => Effect.yieldNow)),
                get: (userId) => users.get(userId).pipe(Effect.tap(() => Effect.yieldNow)),
              });
            }),
          ).pipe(Layer.provide(UserRepository.layer))
        : UserRepository.layer;
      const layerIdentityProvider = Layer.succeed(Authentication.IdentityProvider, {
        publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
        verify: ({ token }) =>
          Effect.succeed({ subject: token, email: `${token}@example.test`, name: token }),
      });
      const layer = Layer.effect(UserService, UserService.make).pipe(
        Layer.provide(layerIdentityProvider),
        Layer.provideMerge(layerUsers),
        Layer.provide(ServerConfig.layerTest({ prefix: "t3-members-test-" })),
        Layer.provideMerge(SqlitePersistence.layerTest),
      );
      return { layer };
    }

    /** Registers an identity and gives it a standing; the first to register is already the admin. */
    const seed = (id: string, standing: Pick<User, "role" | "state">) =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        const registered = yield* users.register({
          id,
          email: `${id}@example.test`,
          displayName: id,
          createdAt,
        });
        const user = { ...registered, ...standing };
        yield* users.update(user);
        return user;
      });

    const seedAdmin = seed(adminId, { role: "admin", state: "active" });
    const seedSecondAdmin = seed(secondAdminId, { role: "admin", state: "active" });
    const seedMember = (id: string) => seed(id, { role: "member", state: "active" });
    const seedPending = (id: string) => seed(id, { role: "member", state: "pending" });

    const stored = (userId: string) =>
      Effect.flatMap(UserRepository.UserRepository, (users) => users.get(userId));

    /** The refusal's reason, or the tag of any other failure. */
    const failureOf = (error: Refused | NotFound) =>
      error._tag === "UserRefused" ? error.reason : error._tag;

    const refusalOf = <A>(change: Effect.Effect<A, Refused | NotFound>) =>
      Effect.flip(change).pipe(Effect.map(failureOf));

    /** Signs a stored user in, returning the session token. */
    const signIn = (userId: string) =>
      UserService.use((users) => users.loginFromClerkSession({ token: userId })).pipe(
        Effect.map((login) => login.token),
      );

    /** Whether the session behind `token` still authenticates. */
    const signedIn = (token: string) =>
      UserService.use((users) => users.authenticate(token)).pipe(
        Effect.as(true),
        Effect.catchTags({ SessionInvalidError: () => Effect.succeed(false) }),
      );

    it.effect("approves pending requests as members or admins, who stay signed in", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const auth = yield* UserService;
          const sessions = yield* UserService;
          yield* seedAdmin;
          const login = yield* auth.loginFromClerkSession({ token: memberId });
          assert.strictEqual((yield* sessions.authenticate(login.token)).state, "pending");

          const approved = yield* members.approve({ userId: memberId, role: "member" });
          assert.deepStrictEqual([approved.state, approved.role], ["active", "member"]);
          assert.deepStrictEqual(yield* stored(memberId), approved);
          const session = yield* sessions.authenticate(login.token);
          assert.deepStrictEqual(
            [session.userId, session.role, session.state],
            [memberId, "member", "active"],
          );

          assert.strictEqual(
            yield* refusalOf(members.approve({ userId: memberId, role: "member" })),
            "invalid_member_state",
          );

          const other = yield* seedPending(otherId);
          const approvedAsAdmin = yield* members.approve({
            userId: other.id,
            role: "admin",
          });
          assert.strictEqual(approvedAsAdmin.role, "admin");
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("declines a pending request, ending its sessions and removing it", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const auth = yield* UserService;
          const sessions = yield* UserService;
          yield* seedAdmin;
          const login = yield* auth.loginFromClerkSession({ token: memberId });
          assert.strictEqual((yield* sessions.authenticate(login.token)).state, "pending");

          yield* members.decline({ userId: memberId });
          assert.isNull(yield* stored(memberId));
          const ended = yield* Effect.flip(sessions.authenticate(login.token));
          assert.strictEqual(ended._tag, "SessionInvalidError");
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("protects the last active admin from demotion and deactivation", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const admin = yield* seedAdmin;
          const second = yield* seedSecondAdmin;
          yield* members.deactivate({ userId: second.id });

          assert.strictEqual(
            yield* refusalOf(members.changeRole({ userId: admin.id, role: "member" })),
            "last_admin_protected",
          );
          assert.strictEqual(
            yield* refusalOf(members.deactivate({ userId: admin.id })),
            "last_admin_protected",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("changes roles as an admin and ends the target's sessions", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const admin = yield* seedAdmin;
          yield* seedSecondAdmin;
          const member = yield* seedMember(memberId);
          const memberToken = yield* signIn(member.id);
          const adminToken = yield* signIn(admin.id);

          const promoted = yield* members.changeRole({
            userId: member.id,
            role: "admin",
          });
          assert.strictEqual(promoted.role, "admin");
          assert.isFalse(yield* signedIn(memberToken));
          assert.isTrue(yield* signedIn(adminToken));

          const promotedToken = yield* signIn(member.id);
          const unchanged = yield* members.changeRole({
            userId: member.id,
            role: "admin",
          });
          assert.deepStrictEqual(unchanged, promoted);
          assert.isTrue(yield* signedIn(promotedToken));

          const demoted = yield* members.changeRole({
            userId: admin.id,
            role: "member",
          });
          assert.strictEqual(demoted.role, "member");
          assert.isFalse(yield* signedIn(adminToken));
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("deactivates and reactivates members and admins while ending their sessions", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          yield* seedAdmin;
          const second = yield* seedSecondAdmin;
          const member = yield* seedMember(memberId);

          const memberToken = yield* signIn(member.id);
          const deactivated = yield* members.deactivate({ userId: member.id });
          assert.strictEqual(deactivated.state, "deactivated");
          assert.isFalse(yield* signedIn(memberToken));

          const reactivated = yield* members.reactivate({ userId: member.id });
          assert.deepStrictEqual([reactivated.state, reactivated.role], ["active", "member"]);
          assert.strictEqual(
            yield* refusalOf(members.reactivate({ userId: member.id })),
            "invalid_member_state",
          );

          const secondToken = yield* signIn(second.id);
          yield* members.deactivate({ userId: second.id });
          assert.isFalse(yield* signedIn(secondToken));
          const adminReactivated = yield* members.reactivate({ userId: second.id });
          assert.deepStrictEqual(
            [adminReactivated.state, adminReactivated.role],
            ["active", "admin"],
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("keeps an active admin when two admins concurrently demote themselves", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ yieldAfterReads: true });
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const users = yield* UserRepository.UserRepository;
          const admin = yield* seedAdmin;
          const second = yield* seedSecondAdmin;

          const results = yield* Effect.forEach(
            [admin, second],
            (user) => members.changeRole({ userId: user.id, role: "member" }).pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual(
            results
              .map((result) => (Result.isSuccess(result) ? "demoted" : failureOf(result.failure)))
              .toSorted(),
            ["demoted", "last_admin_protected"],
          );
          assert.strictEqual(
            (yield* users.list).filter((user) => user.role === "admin" && user.state === "active")
              .length,
            1,
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("sets, keeps and clears a profile's avatar image with its name", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          const users = yield* UserRepository.UserRepository;
          const admin = yield* seedAdmin;
          const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

          const withImage = yield* members.updateProfile(
            admin.id,
            {
              displayName: "Ada",
              avatar: { kind: "image", url: "data:image/png;base64,iVBORw==" },
            },
            content,
          );
          assert.deepStrictEqual(yield* stored(admin.id), withImage);
          assert.match(
            withImage.avatar.kind === "image" ? withImage.avatar.url : "",
            /^\/api\/avatars\/user_admin\?v=/,
          );
          assert.deepStrictEqual(yield* users.avatarImage(admin.id), content);

          const kept = yield* members.updateProfile(admin.id, {
            displayName: "Ada L.",
            avatar: withImage.avatar,
          });
          assert.deepStrictEqual([kept.displayName, kept.avatar.kind], ["Ada L.", "image"]);
          assert.deepStrictEqual(yield* users.avatarImage(admin.id), content);

          const initial = yield* members.updateProfile(admin.id, {
            displayName: "Ada L.",
            avatar: { kind: "initial", color: "green" },
          });
          assert.deepStrictEqual(initial.avatar, { kind: "initial", color: "green" });
          assert.isNull(yield* users.avatarImage(admin.id));
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("keeps a role change that lands while a profile update is in flight", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ yieldAfterReads: true });
        yield* Effect.gen(function* () {
          const members = yield* UserService;
          yield* seedAdmin;
          const member = yield* seedMember(memberId);

          yield* Effect.all(
            [
              members.updateProfile(member.id, { displayName: "Renamed", avatar: member.avatar }),
              members.changeRole({ userId: member.id, role: "admin" }),
            ],
            { concurrency: "unbounded" },
          );
          const updated = yield* stored(member.id);
          assert.deepStrictEqual([updated?.displayName, updated?.role], ["Renamed", "admin"]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  });

  describe("Repository", () => {
    const layer = UserRepository.layer.pipe(Layer.provideMerge(SqlitePersistence.layerTest));
    const createdAt = DateTime.makeUnsafe("2026-09-21T12:00:00.000Z");
    const updatedAt = DateTime.makeUnsafe("2026-09-22T12:00:00.000Z");

    const identity = (id: string) => ({
      id,
      email: `${id}@example.test`,
      displayName: id,
      createdAt,
    });

    it.effect(
      "registers the first identity as the active admin and later ones as pending members",
      () =>
        Effect.gen(function* () {
          const users = yield* UserRepository.UserRepository;
          const first = yield* users.register(identity("user_first"));
          const second = yield* users.register(identity("user_second"));
          assert.deepStrictEqual(
            [first, second].map((user) => `${user.role}:${user.state}`),
            ["admin:active", "member:pending"],
          );
          assert.deepStrictEqual(yield* users.list, [first, second]);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("registers exactly one admin when first sign-ins race", () =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        const registered = yield* Effect.all(
          [users.register(identity("user_first")), users.register(identity("user_second"))],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(registered.map((user) => `${user.role}:${user.state}`).toSorted(), [
          "admin:active",
          "member:pending",
        ]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("stores every field of a user, its avatar image, and its removal", () =>
      Effect.gen(function* () {
        const users = yield* UserRepository.UserRepository;
        const registered = yield* users.register(identity("user_first"));
        const user: User = {
          ...registered,
          role: "member",
          state: "deactivated",
          email: "renamed@example.test",
          displayName: "Ada",
          avatar: { kind: "image", url: "/api/avatars/user_first?v=2026-09-22T12:00:00.000Z" },
          updatedAt,
        };
        const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        yield* users.update(user, content);
        assert.deepStrictEqual(yield* users.get(user.id), user);
        assert.deepStrictEqual(yield* users.avatarImage(user.id), content);
        const initial: User = { ...user, avatar: { kind: "initial", color: "green" } };
        yield* users.update(initial);
        assert.deepStrictEqual(yield* users.get(user.id), initial);
        assert.isNull(yield* users.avatarImage(user.id));

        yield* users.remove(user.id);
        assert.isNull(yield* users.get(user.id));
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("Authentication HTTP", () => {
    const clerkPublishableKey = "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==";
    const identities: Readonly<Record<string, VerifiedClerkIdentity>> = {
      "clerk-token": { subject: "user_1", email: "user_1@example.test", name: "User One" },
      "deactivated-token": { subject: "user_2", email: "user_2@example.test", name: "User Two" },
    };
    const verified: Array<{ readonly token: string; readonly authorizedParty?: string }> = [];
    const identityProvider: Authentication.IdentityProvider["Service"] = {
      publishableKey: clerkPublishableKey,
      verify: (input) => {
        verified.push(input);
        const identity = identities[input.token];
        if (identity !== undefined) return Effect.succeed(identity);
        return input.token === "unreachable-token"
          ? Effect.fail(
              new Authentication.ClerkIdentityProviderUnavailable({
                cause: new Error("jwks fetch to secret-host"),
              }),
            )
          : Effect.fail(
              new Authentication.InvalidClerkIdentityToken({ cause: new Error("expired") }),
            );
      },
    };

    const layerConfig = ServerConfig.layerTest({ prefix: "t3-auth-http-test-" });

    const layerServices = Layer.effect(UserService, UserService.make).pipe(
      Layer.provide(Layer.succeed(Authentication.IdentityProvider, identityProvider)),
      Layer.provideMerge(UserRepository.layer),
      Layer.provideMerge(SqlitePersistence.layerTest),
      Layer.provideMerge(layerConfig),
    );

    // The handler runs in its own runtime, outside it.effect's silenced console.
    const layerRoutes = AuthHttp.layer.pipe(Layer.provideMerge(Logger.layer([])));

    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
    const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: encodeJson(body),
      });

    const deactivatedUser = Effect.gen(function* () {
      const users = yield* UserRepository.UserRepository;
      const user = yield* users.register({
        id: "user_2",
        email: "user_2@example.test",
        displayName: "User Two",
        createdAt: yield* DateTime.now,
      });
      yield* users.update({ ...user, state: "deactivated" });
    });

    const withRoutes = <A>(
      use: (api: {
        readonly signIn: (
          token: unknown,
          headers?: Readonly<Record<string, string>>,
        ) => Promise<Response>;
        readonly login: () => Promise<string>;
        readonly sessionState: (cookie?: string) => Promise<unknown>;
        readonly logout: (cookie?: string) => Promise<Response>;
      }) => Promise<A>,
      options: {
        readonly seed?: Effect.Effect<void, never, UserRepository.UserRepository>;
      } = {},
    ) =>
      Effect.gen(function* () {
        const requestContext = yield* Layer.build(layerServices);
        yield* (options.seed ?? Effect.void).pipe(Effect.provideContext(requestContext));
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
          ({ handler }) => {
            const signIn = (token: unknown, headers?: Readonly<Record<string, string>>) =>
              handler(postJson("/api/auth/clerk-session", token, headers), requestContext);
            return Effect.tryPromise(() =>
              use({
                signIn,
                login: async () => {
                  const response = await signIn("clerk-token", {
                    origin: "https://app.example.test",
                  });
                  expect(response.status).toBe(204);
                  const cookie = response.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
                  expect(cookie).toMatch(/^t45_session_/);
                  return cookie;
                },
                sessionState: async (cookie) => {
                  const response = await handler(
                    new Request(
                      "http://127.0.0.1/api/auth/session",
                      cookie === undefined ? {} : { headers: { cookie } },
                    ),
                    requestContext,
                  );
                  expect(response.status).toBe(200);
                  return response.json();
                },
                logout: (cookie) =>
                  handler(
                    postJson("/api/auth/logout", {}, cookie === undefined ? {} : { cookie }),
                    requestContext,
                  ),
              }),
            );
          },
          ({ dispose }) => Effect.promise(dispose),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

    const deployVersion = process.env.BUILD_SHA || "development";

    it.effect("exchanges a Clerk session token for a browser session cookie", () =>
      withRoutes(async ({ signIn }) => {
        const response = await signIn("clerk-token", {
          origin: "https://app.example.test",
          "user-agent": "Firefox/140.0",
        });

        expect(response.status).toBe(204);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const cookies = response.headers.getSetCookie();
        expect(cookies).toHaveLength(1);
        expect(cookies[0]).toMatch(/^t45_session_[\w-]+=[^;]+;/);
        expect(cookies[0]).toContain("HttpOnly");
        expect(cookies[0]).toContain("SameSite=Lax");
        expect(await response.text()).toBe("");
        expect(verified.at(-1)).toEqual({
          token: "clerk-token",
          authorizedParty: "https://app.example.test",
        });
      }),
    );

    it.effect("refuses Clerk logins with the auth failure body and no cookie", () =>
      withRoutes(
        async ({ signIn }) => {
          const cases = [
            { token: "rejected-token", status: 401, body: { error: "invalid_credential" } },
            { token: "deactivated-token", status: 403, body: { error: "deactivated" } },
            { token: "unreachable-token", status: 500, body: { error: "internal_error" } },
            { token: { token: "clerk-token" }, status: 401, body: { error: "invalid_credential" } },
          ] as const;
          for (const testCase of cases) {
            const response = await signIn(testCase.token);
            expect(response.status).toBe(testCase.status);
            expect(await response.json()).toEqual(testCase.body);
            expect(response.headers.getSetCookie()).toHaveLength(0);
          }
        },
        { seed: deactivatedUser },
      ),
    );

    it.effect(
      "reports the Clerk user and the server's build on the session after a login exchange",
      () =>
        withRoutes(async ({ login, sessionState }) => {
          expect(await sessionState()).toEqual({
            isAuthenticated: false,
            clerkPublishableKey,
            deployVersion,
          });
          expect(await sessionState(await login())).toEqual({
            isAuthenticated: true,
            userId: "user_1",
            role: "admin",
            state: "active",
            deployVersion,
          });
        }),
    );

    it.effect("logs out this browser and keeps its other sessions signed in", () =>
      withRoutes(async ({ login, sessionState, logout }) => {
        const cookie = await login();
        const otherCookie = await login();

        const response = await logout(cookie);
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        const expiredCookies = response.headers.getSetCookie();
        expect(expiredCookies.some((each) => each.includes("Max-Age=0"))).toBe(true);

        expect(await sessionState(cookie)).toMatchObject({ isAuthenticated: false });
        expect(await sessionState(otherCookie)).toMatchObject({ isAuthenticated: true });
        const again = await logout(cookie);
        expect(again.status).toBe(401);
        expect(await again.json()).toEqual({ error: "unauthenticated" });
      }),
    );

    it.effect("refuses to log out a browser without a session", () =>
      withRoutes(async ({ logout }) => {
        const response = await logout();
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthenticated" });
      }),
    );
  });

  it.layer(NodeServices.layer)("User RPC", (it) => {
    const layerSessions = Layer.effect(UserService, UserService.make).pipe(
      Layer.provide(
        Layer.succeed(Authentication.IdentityProvider, {
          publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
          verify: ({ token }) =>
            Effect.succeed({ subject: token, email: `${token}@example.test`, name: token }),
        }),
      ),
      Layer.provideMerge(UserRepository.layer),
      Layer.provideMerge(SqlitePersistence.layerTest),
      Layer.provide(ServerConfig.layerTest({ prefix: "t3-users-handlers-" })),
    );

    const insertUser = (id: string, role: "admin" | "member") =>
      Effect.flatMap(
        SqlClient.SqlClient,
        (
          sql,
        ) => sql`INSERT INTO users (id, role, state, email, display_name, created_at, updated_at)
          VALUES (${id}, ${role}, 'active', ${`${id}@example.test`}, ${id},
            '2026-10-22T12:00:00Z', '2026-10-22T12:00:00Z')`,
      );

    /** A client calling the handlers as `currentUser`, with workflows answering deactivations. */
    const makeClient = (
      currentUser: CurrentUser["Service"],
      memberDeactivated: WorkflowService["Service"]["memberDeactivated"] = () => Effect.undefined,
    ) =>
      RpcTest.makeClient(Users.middleware(Authorization)).pipe(
        Effect.provide(
          UsersHandlers.layer.pipe(
            Layer.provideMerge(
              Layer.merge(
                Layer.succeed(
                  Authorization,
                  Authorization.of((effect) =>
                    Effect.provideService(effect, CurrentUser, currentUser),
                  ),
                ),
                AdminOnly.layer,
              ),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(UserRepository.UserRepository)({}),
                Layer.mock(WorkflowService)({
                  memberDeactivated,
                  // The mock needs every non-function member; the user handlers never run these.
                  taskHooks: {
                    canRun: () => Effect.succeed(false),
                    prepare: () => Effect.succeed(null),
                    changed: () => Effect.void,
                  },
                }),
              ),
            ),
          ),
        ),
      );

    it.effect("deactivates through workflows, whose refusal keeps the member active", () =>
      Effect.gen(function* () {
        yield* insertUser("user-ada", "admin");
        yield* insertUser("user-bob", "member");
        const sessions = yield* UserService;
        const admin = yield* sessions.authenticate(
          (yield* sessions.issue({ userId: "user-ada" })).token,
        );
        const bobs = yield* sessions.issue({ userId: "user-bob" });
        const handedOn: Array<string> = [];
        let refusing = true;
        const client = yield* makeClient(admin, (userId) =>
          refusing
            ? Effect.fail(new Refused({ reason: "last_workflow_admin" }))
            : Effect.sync(() => {
                handedOn.push(userId);
                return undefined;
              }),
        );

        const refused = yield* Effect.flip(client["users.deactivate"]({ userId: "user-bob" }));
        assert.equal(refused._tag === "UserRefused" && refused.reason, "last_workflow_admin");
        assert.equal((yield* sessions.authenticate(bobs.token)).state, "active");

        refusing = false;
        yield* client["users.deactivate"]({ userId: "user-bob" });
        assert.deepStrictEqual(handedOn, ["user-bob"]);
        const ended = yield* Effect.flip(sessions.authenticate(bobs.token));
        assert.equal(ended._tag, "SessionInvalidError");
      }).pipe(Effect.scoped, Effect.provide(layerSessions)),
    );

    it.effect("signs out the caller's other sessions and keeps this one and everyone else's", () =>
      Effect.gen(function* () {
        yield* insertUser("user-ada", "member");
        yield* insertUser("user-bob", "member");
        const sessions = yield* UserService;
        const [current, other, another, bobs] = yield* Effect.all([
          sessions.issue({ userId: "user-ada" }),
          sessions.issue({ userId: "user-ada" }),
          sessions.issue({ userId: "user-ada" }),
          sessions.issue({ userId: "user-bob" }),
        ]);
        const currentUser = yield* sessions.authenticate(current.token);
        const client = yield* makeClient(currentUser);

        assert.deepStrictEqual(yield* client["users.signOutElsewhere"](), { revokedCount: 2 });
        assert.equal(
          (yield* sessions.authenticate(current.token)).sessionId,
          currentUser.sessionId,
        );
        assert.equal((yield* sessions.authenticate(bobs.token)).userId, "user-bob");
        for (const ended of [other, another]) {
          const refused = yield* Effect.flip(sessions.authenticate(ended.token));
          assert.equal(refused._tag, "SessionInvalidError");
        }
        assert.deepStrictEqual(yield* client["users.signOutElsewhere"](), { revokedCount: 0 });
      }).pipe(Effect.scoped, Effect.provide(layerSessions)),
    );
  });
});
