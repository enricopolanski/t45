import type { Role, User } from "@t45/contracts/models/User";
import { useState, useTransition } from "react";

import { useSession } from "../../state/session";
import { ROLE_LABELS, userActions, useUsers } from "../../state/users";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The members area, for admins: pending requests and the member roster with role and lifecycle
 * controls. Role changes and deactivation end the member's sessions.
 */
export function MembersSettings() {
  const users = useUsers();
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Requests"
        headerAction={
          users.pending.length === 0 ? null : (
            <span className="text-xs text-muted-foreground">{users.pending.length} waiting</span>
          )
        }
      >
        {users.pending.length === 0 ? (
          <SettingsRow title="No one is waiting for approval." />
        ) : (
          users.pending.map((user) => <UserRow key={user.id} user={user} />)
        )}
      </SettingsSection>
      <SettingsSection title="Members">
        {users.active.map((user) => (
          <UserRow key={user.id} user={user} />
        ))}
      </SettingsSection>
      {users.deactivated.length > 0 ? (
        <SettingsSection title="Deactivated">
          {users.deactivated.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: Role;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (role: Role) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(role: Role) => ROLE_LABELS[role]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {Object.entries(ROLE_LABELS).map(([role, text]) => (
          <SelectItem key={role} value={role}>
            {text}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function UserRow({ user }: { readonly user: User }) {
  const isViewer = useSession()?.userId === user.id;
  const [approveAs, setApproveAs] = useState<Role>("member");
  const [busy, startTransition] = useTransition();
  switch (user.state) {
    case "pending":
      return (
        <SettingsRow
          title={user.displayName}
          description={`${user.email} · requested access`}
          control={
            <>
              <RoleSelect
                value={approveAs}
                label={`Approve ${user.displayName} as`}
                disabled={busy}
                onChange={setApproveAs}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() => startTransition(() => userActions.approve(user.id, approveAs))}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => startTransition(() => userActions.decline(user.id))}
              >
                Decline
              </Button>
            </>
          }
        />
      );
    case "active":
      return (
        <SettingsRow
          title={isViewer ? `${user.displayName} · You` : user.displayName}
          description={user.email}
          control={
            <>
              <RoleSelect
                value={user.role}
                label={`Role for ${user.displayName}`}
                disabled={busy}
                onChange={(role) => startTransition(() => userActions.changeRole(user.id, role))}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => startTransition(() => userActions.deactivate(user.id))}
              >
                Deactivate
              </Button>
            </>
          }
        />
      );
    case "deactivated":
      return (
        <SettingsRow
          title={user.displayName}
          description={`${user.email} · ${ROLE_LABELS[user.role]}`}
          control={
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => startTransition(() => userActions.reactivate(user.id))}
            >
              Reactivate
            </Button>
          }
        />
      );
  }
}
