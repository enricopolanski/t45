import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { AccountMenu } from "./work/AccountMenu";
import { NotificationBell } from "./work/NotificationBell";

/** The page's top bar, aligned with the sidebar: its children, then notifications and the account menu. */
export function PageHeader({ className, children, ...props }: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      className={cn(
        "flex h-[var(--page-header-height)] shrink-0 items-center gap-3 border-b bg-background pl-(--page-gutter-start) pr-(--page-gutter-end) surface-grain",
        // Clears the floating sidebar toggle that phone widths pin over the header.
        "max-md:pl-(--page-header-content-left)",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-2">
        <NotificationBell />
        <AccountMenu />
      </div>
    </header>
  );
}
