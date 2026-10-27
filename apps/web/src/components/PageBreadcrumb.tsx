import { createLink, useLocation } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";

/** The app's sections whose pages have pages below them, by path prefix. */
const SECTIONS = [
  { label: "Agents", to: "/settings/agents" },
  { label: "Workflows", to: "/settings/workflows" },
  { label: "Blueprints", to: "/settings/workflow-blueprints" },
  { label: "My work", to: "/my-work" },
  { label: "Boards", to: "/boards" },
] as const;

/**
 * The page's location in the app, ending with its title as the page heading. `parent` is a page
 * between the section and this one, such as the blueprint above its steps. Chat supplies an
 * editable title. "Settings" isn't a link: members open workflows without access to it.
 */
export function PageBreadcrumb({
  title,
  parent,
  className,
  currentClassName,
}: {
  readonly title: ReactNode;
  readonly parent?: ReactNode;
  readonly className?: string;
  readonly currentClassName?: string;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const section = SECTIONS.find(({ to }) => pathname.startsWith(`${to}/`));
  return (
    <nav aria-label="Page breadcrumb" className={cn("min-w-0", className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3">
        {pathname.startsWith("/settings/") ? (
          <PageBreadcrumbParent>Settings</PageBreadcrumbParent>
        ) : null}
        {section === undefined ? null : (
          <PageBreadcrumbParent>
            <PageBreadcrumbLink to={section.to}>{section.label}</PageBreadcrumbLink>
          </PageBreadcrumbParent>
        )}
        {parent === undefined ? null : <PageBreadcrumbParent>{parent}</PageBreadcrumbParent>}
        <li
          aria-current="page"
          className={cn("flex min-w-0 items-center font-medium text-foreground", currentClassName)}
        >
          {typeof title === "string" ? (
            <h1 className="min-w-0">
              <PageBreadcrumbText>{title}</PageBreadcrumbText>
            </h1>
          ) : (
            title
          )}
        </li>
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

/** A page above the current one, followed by a separator. */
function PageBreadcrumbParent({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <li className="flex min-w-0 shrink-0 items-center font-medium text-muted-foreground">
        {children}
      </li>
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
