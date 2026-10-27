import { Link } from "@tanstack/react-router";
import { LogOutIcon, SettingsIcon, UserIcon, UsersIcon } from "lucide-react";

import { signOut } from "../../http/auth";
import { toastFailure } from "../../state/query";
import { useIsAdmin, useSession } from "../../state/session";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ActorAvatar } from "./ActorAvatar";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

/**
 * The signed-in person's avatar in page headers: their name, Settings and Members for admins, and
 * Sign out.
 */
export function AccountMenu() {
  const userId = useSession()?.userId;
  const directory = useWorkDirectory();
  const isAdmin = useIsAdmin();
  const name = userId === undefined ? "You" : actorName(directory, userId);

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Account" />}>
        <ActorAvatar actor={userId ?? null} />
      </MenuTrigger>
      <MenuPopup align="end">
        <p className="truncate px-2 py-1.5 text-xs text-muted-foreground">{name}</p>
        <MenuLinkItem render={<Link to="/profile" />}>
          <UserIcon />
          Profile
        </MenuLinkItem>
        {isAdmin ? (
          <>
            <MenuLinkItem render={<Link to="/settings" />}>
              <SettingsIcon />
              Settings
            </MenuLinkItem>
            <MenuLinkItem render={<Link to="/settings/members" />}>
              <UsersIcon />
              Members
            </MenuLinkItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          onClick={() =>
            void signOut().catch((cause: unknown) => toastFailure("Sign-out failed", cause))
          }
        >
          <LogOutIcon />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
