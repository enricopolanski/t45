import { type Message, useTranslation } from "~/i18n/locale";
import { Link, useLocation } from "@tanstack/react-router";
import { InboxIcon, KanbanSquareIcon, LibraryBigIcon, MessagesSquareIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api, type ApiSuccess } from "../../rpc/api";
import { useApiQuery } from "../../state/rpc";
import { collectionListQuery } from "../collections/collectionQueries";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";

export type NavLink = {
  readonly label: Message;
  readonly icon: ReactNode;
  readonly to:
    | "/my-work"
    | "/chats"
    | "/settings/projects"
    | "/settings/collections"
    | "/settings/agents"
    | "/settings/automations"
    | "/settings/organization"
    | "/settings/people";
  /** Shown but not yet open. */
  readonly isWorkInProgress?: boolean;
  /** Pages listed below it, always shown. */
  readonly children?: ReadonlyArray<{
    readonly label: Message;
    readonly to: "/settings/automations/runs" | "/settings/automations/benchmarks";
  }>;
};

/** Everyone's areas. */
const MAIN_LINKS: ReadonlyArray<NavLink> = [
  { label: "My work", icon: <InboxIcon />, to: "/my-work" },
  { label: "Chat", icon: <MessagesSquareIcon />, to: "/chats", isWorkInProgress: true },
];

/** The app's main sidebar, with open boards and published collections. */
export function AppNavSidebar() {
  return (
    <>
      <SidebarChromeHeader />
      <SidebarContent>
        <AppNavGroup label={null}>
          <NavLinks links={MAIN_LINKS} />
        </AppNavGroup>
        <OpenBoards />
        <PublishedCollections />
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

/** The boards the viewer can open, under a heading; with none, nothing. */
function OpenBoards() {
  const t = useTranslation();
  const { setOpenMobile } = useSidebar();
  const boards = useOpenBoards();
  if (boards.length === 0) return null;
  return (
    <AppNavGroup label={t("Boards")}>
      {boards.map((board) => (
        <SidebarMenuItem key={board.id}>
          <SidebarMenuButton
            onClick={() => setOpenMobile(false)}
            render={<Link to="/boards/$slug" params={{ slug: board.slug ?? board.id }} />}
          >
            <KanbanSquareIcon />
            <span>{board.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </AppNavGroup>
  );
}

function PublishedCollections() {
  const t = useTranslation();
  const { setOpenMobile } = useSidebar();
  const { data } = useApiQuery(collectionListQuery);
  const collections =
    data?.filter((collection) => collection.isPublished && collection.extension === undefined) ??
    [];
  if (collections.length === 0) return null;
  return (
    <AppNavGroup label={t("Collections")}>
      {collections.map((collection) => (
        <SidebarMenuItem key={collection.id}>
          <SidebarMenuButton
            onClick={() => setOpenMobile(false)}
            render={
              <Link to="/collections/$collectionId" params={{ collectionId: collection.id }} />
            }
          >
            <LibraryBigIcon />
            <span>{collection.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </AppNavGroup>
  );
}

export function NavLinks({ links }: { readonly links: ReadonlyArray<NavLink> }) {
  const t = useTranslation();
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => setOpenMobile(false);
  return links.map((link) =>
    link.isWorkInProgress === true ? (
      <SidebarMenuItem key={link.to}>
        <SidebarMenuButton disabled>
          {link.icon}
          <span>{t(link.label)}</span>
          <span className="ml-auto text-xs font-normal">{t("Work in progress")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ) : (
      <SidebarMenuItem key={link.to}>
        <SidebarMenuButton onClick={closeMobileSidebar} render={<Link to={link.to} />}>
          {link.icon}
          <span>{t(link.label)}</span>
        </SidebarMenuButton>
        {link.children === undefined ? null : (
          <SidebarMenuSub>
            {link.children.map((child) => (
              <SidebarMenuItem key={child.to}>
                <SidebarMenuButton onClick={closeMobileSidebar} render={<Link to={child.to} />}>
                  <span>{t(child.label)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenuSub>
        )}
      </SidebarMenuItem>
    ),
  );
}

/**
 * The boards the viewer can open: those of the projects with a step they are a member of. Re-read
 * on the project pages, where projects get their people, adopt versions, and are archived.
 */
function useOpenBoards() {
  const [boards, setBoards] = useState<ApiSuccess<"workflows.listBoards">>([]);
  const projectsPath = useLocation({
    select: (location) =>
      location.pathname.startsWith("/settings/projects") || location.pathname.startsWith("/boards")
        ? location.pathname
        : null,
  });
  useEffect(() => {
    let current = true;
    void api("workflows.listBoards", undefined).then(
      (listed) => {
        if (current) setBoards(listed);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-read on each project page.
  }, [projectsPath]);
  return boards;
}

export function AppNavGroup({
  label,
  children,
}: {
  readonly label: string | null;
  readonly children: ReactNode;
}) {
  return (
    <SidebarGroup className="mt-3">
      {label === null ? null : (
        <div className="px-2 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
          {label}
        </div>
      )}
      <SidebarMenu>{children}</SidebarMenu>
    </SidebarGroup>
  );
}
