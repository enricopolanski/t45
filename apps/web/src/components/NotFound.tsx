import { useTranslation } from "~/i18n/locale";
import { Link } from "@tanstack/react-router";

import { Button } from "./ui/button";

export function NotFound() {
  const t = useTranslation();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">{t("Page not found")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("This link doesn't point to a page in T45. Go home to choose where to work.")}
        </p>
        <Button render={<Link to="/" replace />}>{t("Go home")}</Button>
      </div>
    </div>
  );
}
