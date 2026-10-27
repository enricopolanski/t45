import { canManageUsers } from "@t45/contracts/models/User";
import { AuthFailure, AuthSessionState } from "@t45/contracts/resources/Session";
import { redirect } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { api } from "../rpc/api";

export class ServerClerkTokenUnavailableError extends Schema.TaggedError<ServerClerkTokenUnavailableError>()(
  "ServerClerkTokenUnavailableError",
  {},
) {
  override get message(): string {
    return "Clerk did not return a session token. Sign in again.";
  }
}

export class AuthRequestError extends Schema.TaggedError<AuthRequestError>()("AuthRequestError", {
  status: Schema.Number,
  reason: AuthFailure.fields.error,
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_credential":
        return "This sign-in is not valid for this address. Sign out and sign in again.";
      case "deactivated":
        return "Your access to this organization has been deactivated.";
      default:
        return "Couldn't sign in right now. Try again.";
    }
  }
}

export const isAuthRequestError = Schema.is(AuthRequestError);

type ServerAuthGateState =
  | { status: "authenticated" }
  /** Signed in, but the registration is still waiting for an approval. */
  | { status: "awaiting-approval" }
  /** Signed in as an admin, but the organization has no name yet. */
  | { status: "onboarding" }
  | { status: "requires-auth"; clerkPublishableKey: string };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
/** Set once the gate admitted this page; signing out or in clears it. */
let admitted = false;

// A restarting server refuses connections, or answers through its proxy with 502–504.
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

const isAuthFailure = Schema.is(AuthFailure);
const decodeSessionState = Schema.decodeUnknownSync(Schema.fromJsonString(AuthSessionState));

function failureReason(body: string): AuthFailure["error"] {
  try {
    const failure: unknown = JSON.parse(body);
    return isAuthFailure(failure) ? failure.error : "internal_error";
  } catch {
    return "internal_error";
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (response.ok) return response;
  throw new AuthRequestError({
    status: response.status,
    reason: failureReason(await response.text()),
  });
}

const readSessionState = async () =>
  decodeSessionState(await (await request("/api/auth/session")).text());

function isTransientBootstrapError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (isAuthRequestError(error) && TRANSIENT_STATUS_CODES.has(error.status))
  );
}

async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isTransientBootstrapError(error) ||
        Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_RETRY_STEP_MS));
    }
  }
}

export const fetchSessionState = (): Promise<AuthSessionState> =>
  retryTransientBootstrap(readSessionState);

/** Admin pages' route guard: anyone else goes back to the root. */
export async function requireAdmin(): Promise<void> {
  const session = await fetchSessionState();
  if (!session.isAuthenticated || session.role !== "admin")
    throw redirect({ to: "/", replace: true });
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const currentSession = await fetchSessionState();
  if (!currentSession.isAuthenticated) {
    return {
      status: "requires-auth",
      clerkPublishableKey: currentSession.clerkPublishableKey,
    };
  }

  if (currentSession.state === "pending") {
    return { status: "awaiting-approval" };
  }

  // The first member names the organization before the app shell appears.
  if (canManageUsers(currentSession) && (await api("organization.get", undefined)).name === null) {
    return { status: "onboarding" };
  }

  return { status: "authenticated" };
}

/** Exchanges a Clerk session token for the server's session cookie. */
export async function submitClerkSessionToken(token: string): Promise<void> {
  await retryTransientBootstrap(() =>
    request("/api/auth/clerk-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(token),
    }),
  );
  // Re-resolve from the server on the next gate read: the new session may be a
  // pending registration or need onboarding rather than full admission.
  clearServerAuthSessionState();
}

/**
 * Exchanges a Clerk session token for a server session, re-reading the token
 * once when the server rejects it. A cached token minted for another origin is
 * the common cause of a first-attempt rejection, and a fresh read fixes it without
 * signing the user out; a second rejection is surfaced instead of looping.
 */
export async function submitClerkLogin(readToken: () => Promise<string | null>): Promise<void> {
  const token = await readToken();
  if (!token) {
    throw new ServerClerkTokenUnavailableError({});
  }

  try {
    await submitClerkSessionToken(token);
    return;
  } catch (error) {
    if (!(isAuthRequestError(error) && error.reason === "invalid_credential")) {
      throw error;
    }
  }

  const refreshedToken = await readToken();
  if (!refreshedToken) {
    throw new ServerClerkTokenUnavailableError({});
  }
  await submitClerkSessionToken(refreshedToken);
}

/**
 * Ends the current server session from inside it. Clearing the gate state
 * makes the next bootstrap observe the server as unauthenticated instead
 * of reusing the cached authenticated answer.
 */
export const signOut = () =>
  logoutServerSession().then(() => window.location.assign("/login?signedOut=true"));

export async function logoutServerSession(): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } catch (error) {
    // A rejected cookie means the session is already gone; the caller's intent
    // is satisfied either way.
    if (!(isAuthRequestError(error) && error.reason === "unauthenticated")) {
      throw error;
    }
  }
  clearServerAuthSessionState();
}

export async function checkSignedOut(
  reload: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  if (!admitted) return;
  const session = await readSessionState().catch(() => null);
  if (session?.isAuthenticated === false) reload("/login?signedOut=true");
}

/** Drops the cached auth gate so the next read re-observes the server. */
export function clearServerAuthSessionState(): void {
  bootstrapPromise = null;
  admitted = false;
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  if (admitted) {
    return { status: "authenticated" };
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;
  return nextPromise
    .then((result) => {
      if (bootstrapPromise === nextPromise && result.status === "authenticated") {
        admitted = true;
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}
