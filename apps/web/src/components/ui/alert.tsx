import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

const VARIANTS = {
  error: {
    root: "border-destructive/32 bg-destructive/8 text-destructive-foreground [&_svg]:text-destructive",
    description: "text-destructive-foreground/80",
  },
  info: {
    root: "border-info/32 bg-info/4 [&_svg]:text-info",
    description: "text-muted-foreground",
  },
  warning: {
    root: "border-warning/32 bg-warning/4 [&_svg]:text-warning",
    description: "text-muted-foreground",
  },
};

/** A message that stays while its state lasts: errors are alerts, info is a status. */
function Alert({
  variant,
  glass = false,
  icon,
  title,
  action,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  variant: keyof typeof VARIANTS;
  /** Floats the alert over content, tinted by its variant. */
  glass?: boolean;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
        VARIANTS[variant].root,
        glass && "alert-glass",
        className,
      )}
      data-slot="alert"
      data-variant={variant}
      role={variant === "error" ? "alert" : "status"}
      {...props}
    >
      <div className={cn("flex items-start gap-2", action && "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5")}>
        {icon ? (
          <div className="flex h-lh w-4 shrink-0 items-center justify-center [&>svg]:size-4">
            {icon}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title ? <div className="font-medium">{title}</div> : null}
          {children ? (
            <div className={cn("flex flex-col gap-2.5", VARIANTS[variant].description)}>
              {children}
            </div>
          ) : null}
        </div>
        {action ? (
          <div className="flex h-lh shrink-0 items-center gap-1 self-start">{action}</div>
        ) : null}
      </div>
    </div>
  );
}

export { Alert };
