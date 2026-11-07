import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Login } from "../components/auth/Login";

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
    <Login
      signOutFirst={signedOut === true}
      onAuthenticated={() => void navigate({ to: "/", replace: true })}
    />
  );
}
