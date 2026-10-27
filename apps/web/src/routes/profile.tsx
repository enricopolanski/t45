import { createFileRoute } from "@tanstack/react-router";

import { UserProfile } from "../components/people/UserProfile";
import { WorkFrame } from "../components/work/WorkFrame";

function ProfileView() {
  return (
    <WorkFrame title="Your profile">
      <UserProfile />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/profile")({ component: ProfileView });
