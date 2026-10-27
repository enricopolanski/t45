import { createLink, useLocation } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";

/** The app's sections whose pages have pages below them, by path prefix. */
const SECTIONS = [
  { prefix: "/settings/agents/", label: "Agents", to: "/settings/agents" },
  { prefix: "/settings/workflows/", label: "Workflows", to: "/settings/workflows" },
  {
    prefix: "/settings/workflow-blueprints/",
    label: "Blueprints",
    to: "/settings/workflow-blueprints",
  },
  { prefix: "/my-work/", label: "My work", to: "/my-work" },
  { prefix: "/boards/", label: "Boards", to: "/boards" },
] as const;

/**
 * The page's location in the app, ending with its title as the page heading. `parent` is a page
 * between the section and this one, such as the blueprint above its steps. "Settings" isn't a
 * link: members open workflows without access to it.
 */
export function PageLocation({
  title,
  parent,
}: {
  readonly title: string;
  readonly parent?: ReactNode;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const section = SECTIONS.find(({ prefix }) => pathname.startsWith(prefix));
  return (
    <PageBreadcrumb ariaLabel="Page breadcrumb">
      {pathname.startsWith("/settings/") ? (
        <PageBreadcrumbParent>Settings</PageBreadcrumbParent>
      ) : null}
      {section === undefined ? null : (
        <PageBreadcrumbParent>
          <PageBreadcrumbLink to={section.to}>{section.label}</PageBreadcrumbLink>
        </PageBreadcrumbParent>
      )}
      {parent === undefined ? null : <PageBreadcrumbParent>{parent}</PageBreadcrumbParent>}
      <PageBreadcrumbItem current>
        <h1 className="min-w-0">
          <PageBreadcrumbText>{title}</PageBreadcrumbText>
        </h1>
      </PageBreadcrumbItem>
    </PageBreadcrumb>
  );
}

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

/** A page above the current one, followed by a separator. */
export function PageBreadcrumbParent({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <PageBreadcrumbItem>{children}</PageBreadcrumbItem>
      <li aria-hidden="true" className="flex shrink-0 items-center text-icon-muted">
        /
      </li>
    </>
  );
}

/** A link to a page above the current one. The router counts it active; it isn't the current page. */
export const PageBreadcrumbLink = createLink(function PageBreadcrumbAnchor(
  props: ComponentProps<"a">,
) {
  return (
    <a
      {...props}
      aria-current={undefined}
      className="rounded-sm hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
});
