import { useTranslation } from "~/i18n/locale";
import { useState } from "react";

import { signOut } from "../../http/auth";
import { describeFailure } from "../../lib/failures";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";

export function UseAnotherAccountButton() {
  const t = useTranslation();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void signOut().catch((cause: unknown) => setError(describeFailure(cause)))}
      >
        {t("Use another account")}
      </Button>
      {error && <ErrorText text={error} />}
    </div>
  );
}
