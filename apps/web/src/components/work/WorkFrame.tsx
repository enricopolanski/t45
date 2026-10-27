import { createLink } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { SidebarInset } from "../ui/sidebar";
import { Loading } from "../Loading";
import { PageHeader } from "../PageHeader";
import { PageContent } from "../PageContent";
import { PageLocation } from "../PageBreadcrumb";

/**
 * The page shell of the work, workflow and agent pages: a header with the page's location, then
 * the content, starting with the page's actions. The content loads on its own, so the header stays
 * while it does.
 */
export function WorkFrame({
  title,
  parent,
  actions,
  width = "column",
  children,
}: {
  readonly title: string;
  /** A linked page between the page's section and the page, in its location. */
  readonly parent?: ReactNode;
  /** Right-aligned above the content. */
  readonly actions?: ReactNode;
  readonly width?: ComponentProps<typeof PageContent>["width"];
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 scroll-pt-(--page-header-height) overflow-y-auto overscroll-y-none">
      <PageHeader className="sticky top-0 z-10">
        <PageLocation title={title} parent={parent} />
      </PageHeader>
      <PageContent width={width}>
        {actions ? (
          <div className="flex flex-wrap items-center justify-end gap-3">{actions}</div>
        ) : null}
        <Loading>{children}</Loading>
      </PageContent>
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
