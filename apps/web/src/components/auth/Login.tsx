import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import {
  AuthRequestError,
  isAuthRequestError,
  ServerClerkTokenUnavailableError,
  submitClerkLogin,
  submitIdentityToken,
} from "../../http/auth";
import { describeFailure } from "../../lib/failures";
import { clerkAppearance } from "./clerkAppearance";
import { ErrorText } from "../ui/error-text";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../StandalonePage";

/** A failed exchange can be retried this many times before the user must switch accounts. */
const MAX_RETRY_ATTEMPTS = 3;

interface ExchangeAttempt {
  readonly attempt: number;
  readonly promise: Promise<void>;
  /** Set once a subscription has reported this attempt's success. */
  hasSucceeded: boolean;
}

interface SignOutAttempt {
  readonly attempt: number;
  readonly promise: Promise<void>;
  /** Set once a subscription has reported this attempt's outcome. */
  isSettled: boolean;
}

/** Owns identity entry and the exchange for a server session. */
export function Login({
  signOutFirst = false,
  onAuthenticated,
}: {
  /** Set when the server session was just ended: sign out of Clerk before exchanging again. */
  readonly signOutFirst?: boolean;
  readonly onAuthenticated: () => void;
}) {
  // Loopback servers trust an email as the identity token; deployments use Clerk.
  const isEmailTrusting = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Sign in to this server"
        description={
          isEmailTrusting
            ? "Development servers sign you in as any email you enter."
            : "Sign in with your account to continue."
        }
      />
      {isEmailTrusting ? (
        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setIsSubmitting(true);
            setErrorMessage("");
            try {
              await submitIdentityToken(email);
              onAuthenticated();
            } catch (error) {
              setErrorMessage(isAuthRequestError(error) ? error.message : describeFailure(error));
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            Sign in
          </Button>
          {errorMessage && <ErrorText text={errorMessage} />}
        </form>
      ) : (
        <ClerkProvider
          appearance={clerkAppearance}
          publishableKey={process.env.AUTH_CLERK_PUBLISHABLE_KEY ?? ""}
        >
          <ClerkLogin signOutFirst={signOutFirst} onAuthenticated={onAuthenticated} />
        </ClerkProvider>
      )}
    </StandalonePage>
  );
}

// Clerk hooks must run beneath its provider; this child owns only the SDK-specific flow.
function ClerkLogin({
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
  const [isFailureRetryable, setIsFailureRetryable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shouldSignOut, setShouldSignOut] = useState(signOutFirst);
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
    if (!shouldSignOut || !isLoaded) {
      return;
    }
    if (!isSignedIn) {
      // oxlint-disable-next-line react/set-state-in-effect -- the logout request is satisfied when Clerk already has no session; clearing the flag here ends the one-shot state instead of leaking it to the next sign-in.
      setShouldSignOut(false);
      return;
    }

    const previous = signOutAttemptRef.current;
    const signOutAttempt: SignOutAttempt =
      previous?.attempt === signOutAttemptNumber
        ? previous
        : {
            attempt: signOutAttemptNumber,
            promise: signOut({ redirectUrl: "/login" }),
            isSettled: false,
          };
    signOutAttemptRef.current = signOutAttempt;

    void signOutAttempt.promise.then(
      () => {
        if (signOutAttempt.isSettled) {
          return;
        }
        signOutAttempt.isSettled = true;
        // The effect that started this attempt may have been replayed and
        // discarded; completing on the ref keeps the mounted flow from being
        // stranded on "Signing you out…".
        if (signOutAttemptRef.current !== signOutAttempt) {
          return;
        }
        setErrorMessage("");
        setShouldSignOut(false);
      },
      (error: unknown) => {
        if (signOutAttempt.isSettled) {
          return;
        }
        signOutAttempt.isSettled = true;
        if (signOutAttemptRef.current !== signOutAttempt) {
          return;
        }
        setErrorMessage(describeFailure(error, "Sign-out failed."));
      },
    );
  }, [isLoaded, isSignedIn, shouldSignOut, signOut, signOutAttemptNumber]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || shouldSignOut) {
      return;
    }

    const previous = exchangeRef.current;
    const exchange: ExchangeAttempt =
      previous?.attempt === attempt
        ? previous
        : {
            attempt,
            promise: submitClerkLogin(() => getToken({ skipCache: true })),
            hasSucceeded: false,
          };
    exchangeRef.current = exchange;

    let isCancelled = false;
    void exchange.promise.then(
      () => {
        // The effect may have been torn down and replayed while the exchange
        // was in flight; that is not a reason to drop a successful login.
        if (exchange.hasSucceeded) {
          return;
        }
        exchange.hasSucceeded = true;
        onAuthenticatedRef.current();
      },
      (error: unknown) => {
        if (!isCancelled) {
          setErrorMessage(describeClerkLoginFailure(error));
          setIsFailureRetryable(!(isAuthRequestError(error) && error.reason === "deactivated"));
        }
      },
    );
    return () => {
      isCancelled = true;
    };
  }, [attempt, getToken, isLoaded, isSignedIn, shouldSignOut]);

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
    setIsFailureRetryable(false);
    setAttempt((value) => value + 1);
    setShouldSignOut(true);
    // Always start a fresh sign-out attempt: re-entering the flow after an
    // earlier attempt settled must not reuse its promise.
    setSignOutAttemptNumber((value) => value + 1);
  };

  const canRetry = isFailureRetryable && retryCount < MAX_RETRY_ATTEMPTS && !shouldSignOut;
  const hasSignOutFailed = shouldSignOut && errorMessage.length > 0;
  const shouldShowAccountActions = errorMessage.length > 0;

  return (
    <div className="mt-6 flex flex-col items-center gap-4">
      {shouldSignOut ? (
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
      {errorMessage && <ErrorText text={errorMessage} />}
      {shouldShowAccountActions ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canRetry || hasSignOutFailed ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={hasSignOutFailed ? retrySignOut : retry}
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
  );
}

const isSignInFailure = Schema.is(
  Schema.Union([AuthRequestError, ServerClerkTokenUnavailableError]),
);

function describeClerkLoginFailure(error: unknown) {
  return isSignInFailure(error) ? error.message : describeFailure(error);
}
