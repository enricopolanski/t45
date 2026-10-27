import { LogOutIcon } from "lucide-react";
import { useTransition } from "react";

import { api } from "../../rpc/api";
import { toastFailure } from "../../state/query";
import { updateProfile, useProfile } from "../../state/users";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Section } from "../Section";
import { AvatarEditor } from "./AvatarEditor";

/** Edit the signed-in user's name and avatar. */
export function UserProfile() {
  const profile = useProfile();
  return (
    <>
      <AvatarEditor
        className="mt-6"
        name={profile.displayName}
        avatar={profile.avatar}
        autoFocus
        onSave={(displayName, avatar) => void updateProfile({ displayName, avatar })}
      />
      <Sessions />
    </>
  );
}

function Sessions() {
  const [busy, startTransition] = useTransition();
  const signOutElsewhere = () =>
    startTransition(async () => {
      try {
        await api("users.signOutElsewhere", undefined);
        toastManager.add({ type: "success", title: "Signed out everywhere else" });
      } catch (cause) {
        toastFailure("Sign-out failed", cause);
      }
    });
  return (
    <Section
      title="Sessions"
      description="Stay signed in here and sign out of every other browser."
    >
      <div>
        <Button variant="destructive-outline" disabled={busy} onClick={signOutElsewhere}>
          <LogOutIcon />
          Sign out everywhere else
        </Button>
      </div>
    </Section>
  );
}
