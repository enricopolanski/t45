import { useTranslation } from "~/i18n/locale";
import { Link } from "@tanstack/react-router";

const tabClassName =
  "rounded-lg border border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary/25 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary";

/** Tabs between projects and workflows, at the start of their pages' actions. */
export function WorkflowNavigation() {
  const t = useTranslation();
  return (
    <nav aria-label={t("Workflow navigation")} className="mr-auto flex flex-wrap gap-2">
      <Link to="/settings/projects" className={tabClassName}>
        {t("Projects")}
      </Link>
      <Link to="/settings/workflows" className={tabClassName}>
        {t("Workflows")}
      </Link>
    </nav>
  );
}
