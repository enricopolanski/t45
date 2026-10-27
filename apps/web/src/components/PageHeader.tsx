import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

/** Keeps page headers aligned with the sidebar. */
export function PageHeader({ className, ...props }: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      className={cn(
        "flex h-[var(--page-header-height)] shrink-0 items-center gap-3 pl-(--page-gutter-start) pr-(--page-gutter-end)",
        // Clears the floating sidebar toggle that phone widths pin over the header.
        "max-md:pl-(--page-header-content-left)",
        className,
      )}
      {...props}
    />
  );
}
