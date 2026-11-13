import { Link, useLocation } from "@tanstack/react-router";
import { InboxIcon, KanbanSquareIcon, MessagesSquareIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api, type ApiSuccess } from "../../rpc/api";
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
  readonly label: string;
  readonly icon: ReactNode;
  readonly to:
    | "/boards"
    | "/my-work"
    | "/chats"
    | "/settings/projects"
    | "/settings/agents"
    | "/settings/automations"
    | "/settings/organization"
    | "/settings/people";
};

/** Everyone's areas. */
const MAIN_LINKS: ReadonlyArray<NavLink> = [
  { label: "My work", icon: <InboxIcon />, to: "/my-work" },
  { label: "Chat", icon: <MessagesSquareIcon />, to: "/chats" },
  { label: "Boards", icon: <KanbanSquareIcon />, to: "/boards" },
];

/** The app's main sidebar, for everyone: My work, Chat, and Boards (or the one board). */
export function AppNavSidebar() {
  return (
    <>
      <SidebarChromeHeader />
      <SidebarContent>
        <AppNavGroup label={null}>
          <NavLinks links={MAIN_LINKS} />
        </AppNavGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

export function NavLinks({ links }: { readonly links: ReadonlyArray<NavLink> }) {
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => setOpenMobile(false);
  return links.map((link) =>
    link.to === "/boards" ? (
      <BoardsItem key={link.to} link={link} onNavigate={closeMobileSidebar} />
    ) : (
      <SidebarMenuItem key={link.to}>
        <SidebarMenuButton onClick={closeMobileSidebar} render={<Link to={link.to} />}>
          {link.icon}
          <span>{link.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ),
  );
}

/**
 * Boards, with each board the viewer can open listed below it; a viewer with a single board
 * gets that board in its place.
 */
function BoardsItem({
  link,
  onNavigate,
}: {
  readonly link: NavLink;
  readonly onNavigate: () => void;
}) {
  const boards = useOpenBoards();
  const [only] = boards;
  if (only !== undefined && boards.length === 1) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onNavigate}
          render={<Link to="/boards/$slug" params={{ slug: only.slug ?? only.id }} />}
        >
          {link.icon}
          <span>{only.name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onNavigate}
        render={<Link to={link.to} activeOptions={{ exact: true }} />}
      >
        {link.icon}
        <span>{link.label}</span>
      </SidebarMenuButton>
      {boards.length > 0 ? (
        <SidebarMenuSub>
          {boards.map((board) => (
            <SidebarMenuItem key={board.id}>
              <SidebarMenuButton
                onClick={onNavigate}
                render={<Link to="/boards/$slug" params={{ slug: board.slug ?? board.id }} />}
              >
                <span>{board.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
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
