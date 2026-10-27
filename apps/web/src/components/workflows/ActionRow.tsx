import type { ReactNode } from "react";

/** One row of a settings card: what the action does on the left, its button on the right. */
export function ActionRow({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description !== undefined ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
