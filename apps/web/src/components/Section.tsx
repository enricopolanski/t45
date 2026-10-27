import { type ReactNode, useId } from "react";

export function Section({
  title,
  description,
  action,
  card = false,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly card?: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id={id} className="text-sm font-semibold">
            {title}
          </h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {card ? <div className="card flex flex-col gap-3 p-4">{children}</div> : children}
    </section>
  );
}
