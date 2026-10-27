import { useNavigate } from "@tanstack/react-router";

import { api } from "../../rpc/api";
import { useSubmit } from "../../hooks/useSubmit";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../StandalonePage";
import { ErrorText } from "../ui/error-text";
import { UseAnotherAccountButton } from "../auth/UseAnotherAccountButton";

/**
 * The first admin's first step: the organization has no name until an admin
 * names it here.
 */
export function OrganizationOnboarding() {
  const navigate = useNavigate();
  const {
    error,
    pending: submitting,
    onSubmit,
  } = useSubmit(async (fields) => {
    await api("organization.rename", { name: String(fields.get("name")).trim() });
    // The root gate re-resolves on this navigation and admits the shell.
    await navigate({ to: "/", replace: true });
  });

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Name your organization"
        description="This deployment becomes your organization's home. You can change the name later."
      />
      <form className="mt-6 flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label="Organization name">
          <Input
            name="name"
            required
            pattern=".*\S.*"
            autoFocus
            maxLength={80}
            placeholder="Acme"
          />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex items-center justify-between gap-2">
          <UseAnotherAccountButton />
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "Creating…" : "Create organization"}
          </Button>
        </div>
      </form>
    </StandalonePage>
  );
}
