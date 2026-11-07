import type { Organization } from "@t45/contracts/models/Organization";
import { type Role, type State } from "@t45/contracts/models/User";
import type { AuthFailure, AuthSessionState } from "@t45/contracts/resources/Session";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rpc = vi.hoisted(() => ({
  organization: null as Organization | null,
  calls: [] as Array<string>,
}));

vi.mock("./rpc/api", () => ({
  api: async (tag: string) => {
    rpc.calls.push(tag);
    if (tag === "organization.get" && rpc.organization !== null) return rpc.organization;
    throw new Error(`Unexpected RPC call: ${tag}`);
  },
}));

type TestWindow = {
  location: URL;
};

const CREATED_AT = DateTime.makeUnsafe("2026-04-05T00:00:00.000Z");
const DEPLOY_VERSION = "development";
const signedOut: AuthSessionState = {
  isAuthenticated: false,
  deployVersion: DEPLOY_VERSION,
};
const signedIn = (role: Role = "member", state: State = "active"): AuthSessionState => ({
  isAuthenticated: true,
  userId: "user-first",
  role,
  state,
  deployVersion: DEPLOY_VERSION,
});

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T45" });

  return testWindow;
}

function sequence<A>(...values: ReadonlyArray<A>) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

const ok = (body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: 200 });
const refused = (status: number, error: AuthFailure["error"]) =>
  new Response(JSON.stringify({ error }), { status });

type Answer = () => Response | Promise<Response>;

function installAuthRoutes(routes: {
  readonly session?: Answer;
  readonly login?: (token: string) => Response;
  readonly logout?: Answer;
}) {
  const calls = { session: 0, login: [] as Array<string>, logout: 0 };
  const unexpected = (path: string) => Promise.reject(new Error(`Unexpected request: ${path}`));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    switch (path) {
      case "/api/auth/session":
        calls.session += 1;
        return routes.session?.() ?? unexpected(path);
      case "/api/auth/login": {
        const token: string = JSON.parse(String(init?.body));
        calls.login.push(token);
        return routes.login?.(token) ?? unexpected(path);
      }
      case "/api/auth/logout":
        calls.logout += 1;
        return routes.logout?.() ?? unexpected(path);
      default:
        return unexpected(path);
    }
  });
  return calls;
}

const sessions = (next: () => AuthSessionState) => () => ok(next());

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  installTestBrowser("http://localhost/");
  rpc.organization = null;
  rpc.calls = [];
});

afterEach(async () => {
  const { clearServerAuthSessionState } = await import("./http/auth");
  clearServerAuthSessionState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveInitialServerAuthGateState", () => {
  it("reuses an in-flight session bootstrap attempt", async () => {
    const calls = installAuthRoutes({ session: sessions(sequence(signedOut)) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(calls.session).toBe(1);
  });

  it("returns a requires-auth state when the session is unauthenticated", async () => {
    installAuthRoutes({ session: sessions(() => signedOut) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
    });
  });

  it("routes a pending registration to the awaiting-approval gate", async () => {
    installAuthRoutes({ session: sessions(() => signedIn("member", "pending")) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "awaiting-approval",
    });
    expect(rpc.calls).toEqual([]);
  });

  it("routes an admin to onboarding until the organization is named", async () => {
    installAuthRoutes({ session: sessions(() => signedIn("admin")) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    rpc.organization = {
      name: null,
      avatar: { kind: "initial", color: "slate" },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "onboarding" });

    rpc.organization = {
      name: "Acme",
      avatar: { kind: "initial", color: "slate" },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(rpc.calls).toEqual(["organization.get", "organization.get"]);
  });

  it("admits an active member without asking for the organization", async () => {
    installAuthRoutes({ session: sessions(() => signedIn()) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(rpc.calls).toEqual([]);
  });

  it("retries refused connections and gateway errors while the server restarts", async () => {
    vi.useFakeTimers();
    const attempt = sequence<Answer>(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response("Bad Gateway", { status: 502 }),
      () => new Response("Bad Gateway", { status: 502 }),
      () => ok(signedOut),
    );
    const calls = installAuthRoutes({ session: () => attempt()() });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
    });
    expect(calls.session).toBe(4);
  });

  it("exchanges a fresh Clerk token and resets the authenticated gate", async () => {
    const calls = installAuthRoutes({
      session: sessions(sequence(signedOut, signedIn())),
      login: () => ok(),
    });
    const { resolveInitialServerAuthGateState, submitIdentityToken } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
    });
    await expect(submitIdentityToken("fresh-clerk-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(calls.login).toEqual(["fresh-clerk-token"]);
    expect(calls.session).toBe(2);
  });

  it("retries a rejected Clerk exchange once with a re-read token", async () => {
    const calls = installAuthRoutes({
      login: (token) => (token === "stale-token" ? refused(401, "invalid_credential") : ok()),
    });
    const { submitClerkLogin } = await import("./http/auth");
    const tokens = ["stale-token", "fresh-token"];
    let reads = 0;

    await expect(submitClerkLogin(async () => tokens[reads++] ?? null)).resolves.toBeUndefined();

    expect(calls.login).toEqual(["stale-token", "fresh-token"]);
    expect(reads).toBe(2);
  });

  it("surfaces a second rejected Clerk exchange and a missing token", async () => {
    const calls = installAuthRoutes({
      login: () => refused(401, "invalid_credential"),
    });
    const { AuthRequestError, ServerClerkTokenUnavailableError, submitClerkLogin } =
      await import("./http/auth");
    let reads = 0;

    await expect(submitClerkLogin(async () => null)).rejects.toBeInstanceOf(
      ServerClerkTokenUnavailableError,
    );
    const failure = submitClerkLogin(async () => `clerk-token-${++reads}`);
    await expect(failure).rejects.toBeInstanceOf(AuthRequestError);
    await expect(failure).rejects.toMatchObject({
      status: 401,
      reason: "invalid_credential",
      message: "This sign-in is not valid for this address. Sign out and sign in again.",
    });
    expect(calls.login).toEqual(["clerk-token-1", "clerk-token-2"]);
    expect(calls.session).toBe(0);
  });

  it("does not re-read the token for a deactivated account", async () => {
    const calls = installAuthRoutes({ login: () => refused(403, "deactivated") });
    const { submitClerkLogin } = await import("./http/auth");
    let reads = 0;

    await expect(submitClerkLogin(async () => `clerk-token-${++reads}`)).rejects.toMatchObject({
      status: 403,
      reason: "deactivated",
      message: "Your access to this organization has been deactivated.",
    });
    expect(reads).toBe(1);
    expect(calls.login).toEqual(["clerk-token-1"]);
  });

  it("reads a refusal whose body isn't an auth failure as an internal error", async () => {
    installAuthRoutes({ login: () => new Response("upstream timeout", { status: 500 }) });
    const { submitIdentityToken } = await import("./http/auth");

    await expect(submitIdentityToken("clerk-token")).rejects.toMatchObject({
      status: 500,
      reason: "internal_error",
      message: "Couldn't sign in right now. Try again.",
    });
  });

  it("memoizes the authenticated gate state after the first successful read", async () => {
    const calls = installAuthRoutes({ session: sessions(sequence(signedIn(), signedOut)) });
    const { resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(calls.session).toBe(1);
  });

  it("logs the server session out and makes the next gate read unauthenticated", async () => {
    const calls = installAuthRoutes({
      session: sessions(sequence(signedIn(), signedOut)),
      logout: () => ok(),
    });
    const { logoutServerSession, resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(logoutServerSession()).resolves.toBeUndefined();
    expect(calls.logout).toBe(1);
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
    });
  });

  it("treats a logout without a session as already signed out", async () => {
    const calls = installAuthRoutes({
      session: sessions(sequence(signedIn(), signedOut)),
      logout: () => refused(401, "unauthenticated"),
    });
    const { logoutServerSession, resolveInitialServerAuthGateState } = await import("./http/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(logoutServerSession()).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
    });
    expect(calls.session).toBe(2);
  });
});

describe("checkSignedOut", () => {
  const admit = async (session: () => AuthSessionState) => {
    installAuthRoutes({ session: sessions(session) });
    const auth = await import("./http/auth");
    await expect(auth.resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    return auth;
  };

  it("reloads an admitted page to sign-in once its session answers signed out", async () => {
    const { checkSignedOut } = await admit(sequence(signedIn(), signedOut));
    const reloads: Array<string> = [];

    await checkSignedOut((url) => reloads.push(url));

    expect(reloads).toEqual(["/login?signedOut=true"]);
  });

  it("keeps an admitted page whose session is still signed in", async () => {
    const { checkSignedOut } = await admit(() => signedIn("member"));
    const reloads: Array<string> = [];

    await checkSignedOut((url) => reloads.push(url));

    expect(reloads).toEqual([]);
  });

  it("keeps an admitted page when the session can't be read", async () => {
    const { checkSignedOut } = await admit(() => signedIn());
    installAuthRoutes({ session: () => Promise.reject(new TypeError("Failed to fetch")) });
    const reloads: Array<string> = [];

    await checkSignedOut((url) => reloads.push(url));

    expect(reloads).toEqual([]);
  });
});
