import { useTranslation } from "~/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";

import { UserProfile } from "../components/people/UserProfile";
import { WorkFrame } from "../components/work/WorkFrame";

function ProfileView() {
  const t = useTranslation();
  return (
    <WorkFrame title={t("Your profile")}>
      <UserProfile />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/profile")({ component: ProfileView });
