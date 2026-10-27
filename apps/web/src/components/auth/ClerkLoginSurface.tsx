import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import {
  AuthRequestError,
  isAuthRequestError,
  ServerClerkTokenUnavailableError,
  submitClerkLogin,
} from "../../http/auth";
import { describeFailure } from "../../lib/failures";
import { clerkAppearance } from "./clerkAppearance";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../StandalonePage";

/** A failed exchange can be retried this many times before the user must switch accounts. */
const MAX_RETRY_ATTEMPTS = 3;

interface ExchangeAttempt {
  readonly attempt: number;
  readonly promise: Promise<void>;
  /** Set once a subscription has reported this attempt's success. */
  succeeded: boolean;
}

interface SignOutAttempt {
  readonly attempt: number;
  readonly promise: Promise<void>;
  /** Set once a subscription has reported this attempt's outcome. */
  settled: boolean;
}

/**
 * Browser sign-in for the server itself: the key comes from the server's
 * descriptor, so the tenant always matches the server that will verify the
 * token.
 *
 * The surface owns its Clerk provider; T45 never mounts a second one above it.
 */
export function ClerkLoginSurface({
  publishableKey,
  signOutFirst = false,
  onAuthenticated,
}: {
  readonly publishableKey: string;
  /** Set when the server session was just ended: sign out of Clerk before exchanging again. */
  readonly signOutFirst?: boolean;
  readonly onAuthenticated: () => void;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      <ClerkLoginFlow signOutFirst={signOutFirst} onAuthenticated={onAuthenticated} />
    </ClerkProvider>
  );
}

function ClerkLoginFlow({
  signOutFirst,
  onAuthenticated,
}: {
  readonly signOutFirst: boolean;
  readonly onAuthenticated: () => void;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { signOut } = useClerk();
  const [errorMessage, setErrorMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [lastFailureRetryable, setLastFailureRetryable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pendingSignOut, setPendingSignOut] = useState(signOutFirst);
  const [signOutAttemptNumber, setSignOutAttemptNumber] = useState(0);
  const onAuthenticatedRef = useRef(onAuthenticated);
  // The pipeline of a single exchange attempt. Holding it in a ref keeps a
  // replayed effect (StrictMode, changed callback) attached to the exchange it
  // started instead of losing its result.
  const exchangeRef = useRef<ExchangeAttempt | null>(null);
  // The same custody rule for Clerk sign-out: a replayed effect must observe
  // the in-flight attempt, and its outcome must land on the current flow.
  const signOutAttemptRef = useRef<SignOutAttempt | null>(null);

  useEffect(() => {
    onAuthenticatedRef.current = onAuthenticated;
  }, [onAuthenticated]);

  useEffect(() => {
    if (!pendingSignOut || !isLoaded) {
      return;
    }
    if (!isSignedIn) {
      // oxlint-disable-next-line react/set-state-in-effect -- the logout request is satisfied when Clerk already has no session; clearing the flag here ends the one-shot state instead of leaking it to the next sign-in.
      setPendingSignOut(false);
      return;
    }

    const previous = signOutAttemptRef.current;
    const signOutAttempt: SignOutAttempt =
      previous?.attempt === signOutAttemptNumber
        ? previous
        : {
            attempt: signOutAttemptNumber,
            promise: signOut({ redirectUrl: "/login" }),
            settled: false,
          };
    signOutAttemptRef.current = signOutAttempt;

    void signOutAttempt.promise.then(
      () => {
        if (signOutAttempt.settled) {
          return;
        }
        signOutAttempt.settled = true;
        // The effect that started this attempt may have been replayed and
        // discarded; completing on the ref keeps the mounted flow from being
        // stranded on "Signing you out…".
        if (signOutAttemptRef.current !== signOutAttempt) {
          return;
        }
        setErrorMessage("");
        setPendingSignOut(false);
      },
      (error: unknown) => {
        if (signOutAttempt.settled) {
          return;
        }
        signOutAttempt.settled = true;
        if (signOutAttemptRef.current !== signOutAttempt) {
          return;
        }
        setErrorMessage(describeFailure(error, "Sign-out failed."));
      },
    );
  }, [isLoaded, isSignedIn, pendingSignOut, signOut, signOutAttemptNumber]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || pendingSignOut) {
      return;
    }

    const previous = exchangeRef.current;
    const exchange: ExchangeAttempt =
      previous?.attempt === attempt
        ? previous
        : {
            attempt,
            promise: submitClerkLogin(() => getToken({ skipCache: true })),
            succeeded: false,
          };
    exchangeRef.current = exchange;

    let cancelled = false;
    void exchange.promise.then(
      () => {
        // The effect may have been torn down and replayed while the exchange
        // was in flight; that is not a reason to drop a successful login.
        if (exchange.succeeded) {
          return;
        }
        exchange.succeeded = true;
        onAuthenticatedRef.current();
      },
      (error: unknown) => {
        if (!cancelled) {
          setErrorMessage(clerkLoginErrorMessage(error));
          setLastFailureRetryable(!(isAuthRequestError(error) && error.reason === "deactivated"));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, getToken, isLoaded, isSignedIn, pendingSignOut]);

  const retry = () => {
    exchangeRef.current = null;
    setErrorMessage("");
    setRetryCount((count) => count + 1);
    setAttempt((value) => value + 1);
  };

  /** A rejected sign-out blocks the exchange; a new attempt number restarts it. */
  const retrySignOut = () => {
    setErrorMessage("");
    setSignOutAttemptNumber((value) => value + 1);
  };

  const switchAccount = () => {
    exchangeRef.current = null;
    setErrorMessage("");
    setRetryCount(0);
    setLastFailureRetryable(false);
    setAttempt((value) => value + 1);
    setPendingSignOut(true);
    // Always start a fresh sign-out attempt: re-entering the flow after an
    // earlier attempt settled must not reuse its promise.
    setSignOutAttemptNumber((value) => value + 1);
  };

  const canRetry = lastFailureRetryable && retryCount < MAX_RETRY_ATTEMPTS && !pendingSignOut;
  const signOutFailed = pendingSignOut && errorMessage.length > 0;
  const showAccountActions = errorMessage.length > 0;

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Sign in to this server"
        description="Sign in with your account to continue."
      />
      <div className="mt-6 flex flex-col items-center gap-4">
        {pendingSignOut ? (
          errorMessage ? null : (
            <p role="status" className="text-sm text-muted-foreground">
              Signing you out…
            </p>
          )
        ) : (
          <>
            {isSignedIn ? null : <SignIn fallbackRedirectUrl="/login" />}
            {isSignedIn && !errorMessage ? (
              <p role="status" className="text-sm text-muted-foreground">
                Preparing your session…
              </p>
            ) : null}
          </>
        )}
        {errorMessage ? (
          <Alert variant="error" className="w-full">
            {errorMessage}
          </Alert>
        ) : null}
        {showAccountActions ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {canRetry || signOutFailed ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={signOutFailed ? retrySignOut : retry}
              >
                Try again
              </Button>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={switchAccount}>
              Use another account
            </Button>
          </div>
        ) : null}
      </div>
    </StandalonePage>
  );
}

const isSignInFailure = Schema.is(
  Schema.Union([AuthRequestError, ServerClerkTokenUnavailableError]),
);

function clerkLoginErrorMessage(error: unknown) {
  return isSignInFailure(error) ? error.message : describeFailure(error);
}
