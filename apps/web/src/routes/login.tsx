import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ClerkLoginSurface } from "../components/auth/ClerkLoginSurface";

/** The only unauthenticated gate: the browser signs in with the Clerk key the server advertises. */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { signedOut?: true } =>
    search.signedOut === true ? { signedOut: true } : {},
  component: LoginRouteView,
});

function LoginRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { signedOut } = Route.useSearch();
  const navigate = useNavigate();
  if (authGateState.status !== "requires-auth") return null;

  return (
    <ClerkLoginSurface
      publishableKey={authGateState.clerkPublishableKey}
      signOutFirst={signedOut === true}
      onAuthenticated={() => void navigate({ to: "/", replace: true })}
    />
  );
}
