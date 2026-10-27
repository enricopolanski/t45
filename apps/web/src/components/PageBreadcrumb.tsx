import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function PageBreadcrumb({
  ariaLabel,
  children,
  className,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn("min-w-0", className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3">
        {children}
      </ol>
    </nav>
  );
}

export function PageBreadcrumbText({ children }: { readonly children: ReactNode }) {
  return (
    // Center the capital letters with adjacent icons, not the font's leading.
    // Padding preserves accents and descenders when a label is truncated.
    <span className="block min-w-0 truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5">
      {children}
    </span>
  );
}

export function PageBreadcrumbItem({
  children,
  className,
  current = false,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly current?: boolean;
}) {
  return (
    <li
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center font-medium",
        current ? "text-foreground" : "shrink-0 text-muted-foreground",
        className,
      )}
    >
      {children}
    </li>
  );
}

export function PageBreadcrumbSeparator() {
  return (
    <li aria-hidden="true" className="flex shrink-0 items-center text-icon-muted">
      /
    </li>
  );
}
