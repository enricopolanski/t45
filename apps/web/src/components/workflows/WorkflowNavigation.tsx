import { Link } from "@tanstack/react-router";

const tabClassName =
  "rounded-lg border border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary/25 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary";

export function WorkflowNavigation() {
  return (
    <nav aria-label="Workflow navigation" className="flex flex-wrap gap-2">
      <Link to="/settings/workflows" className={tabClassName}>
        Workflows
      </Link>
      <Link to="/settings/workflow-blueprints" className={tabClassName}>
        Blueprints
      </Link>
    </nav>
  );
}
