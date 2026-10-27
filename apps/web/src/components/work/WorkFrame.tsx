import { createLink } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarInset } from "../ui/sidebar";
import { Loading } from "../Loading";
import { PageHeader } from "../PageHeader";
import { NotificationBell } from "./NotificationBell";
import { AccountMenu } from "./AccountMenu";

const WIDTHS = {
  column: "mx-auto max-w-[60rem]",
  split: "mx-auto max-w-7xl",
  full: "",
};

/**
 * The page shell of the work and workflow pages: a title bar with the bell and any page
 * actions, then a centered column that starts with an optional way back. The column loads on its
 * own, so the title bar stays while it does.
 */
export function WorkFrame({
  title,
  back,
  actions,
  width = "column",
  children,
}: {
  readonly title: string;
  readonly back?: ReactNode;
  readonly actions?: ReactNode;
  /** A centered column; wider for an item beside its side cards; the full width for boards. */
  readonly width?: keyof typeof WIDTHS;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 scroll-pt-(--page-header-height) overflow-y-auto overscroll-y-none">
      <PageHeader className="sticky top-0 z-10 border-b bg-background surface-grain">
        <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <NotificationBell />
          <AccountMenu />
        </div>
      </PageHeader>
      <div className={cn("flex w-full flex-col gap-6 px-6 py-7", WIDTHS[width])}>
        {back}
        <Loading>{children}</Loading>
      </div>
    </SidebarInset>
  );
}

/** A page's way back, above its content: a router link with a chevron. */
export const BackLink = createLink(function BackAnchor({
  children,
  ...props
}: ComponentProps<"a">) {
  return (
    <a
      {...props}
      className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeftIcon className="size-3.5" />
      {children}
    </a>
  );
});
