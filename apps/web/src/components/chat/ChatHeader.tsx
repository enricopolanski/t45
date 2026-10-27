import { useRouter } from "@tanstack/react-router";
import { Button } from "../ui/button";
import type { ChatId } from "@t45/contracts/models/Chat";
import { ChevronDownIcon, PencilIcon, ShrinkIcon, Trash2Icon } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertDialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { forgetChatDrafts } from "../../questionDrafts";
import { api } from "../../rpc/api";
import { describeFailure, isNotFound } from "../../lib/failures";
import { PageBreadcrumb, PageBreadcrumbLink, PageBreadcrumbText } from "../PageBreadcrumb";

interface ChatHeaderProps {
  activeChatId: ChatId;
  activeChatTitle: string;
  compactDisabled: boolean;
  onCompactContext: () => void;
}

function errorToast(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: describeFailure(error),
  });
}

export function ChatHeader({
  activeChatId,
  activeChatTitle,
  compactDisabled,
  onCompactContext,
}: ChatHeaderProps) {
  // Inline rename, keyed by chat: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on chat change (not
  // just hidden) so returning to the chat doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{
    chatId: ChatId;
    title: string;
  } | null>(null);
  if (renaming !== null && renaming.chatId !== activeChatId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.title ?? null;
  const renameCommittedRef = useRef(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const router = useRouter();
  const startRename = () => {
    renameCommittedRef.current = false;
    setRenaming({ chatId: activeChatId, title: activeChatTitle });
  };
  const commitRename = (input: string) => {
    setRenaming(null);
    const title = input.trim();
    if (title.length === 0) {
      toastManager.add({ type: "warning", title: "Chat title cannot be empty" });
      return;
    }
    if (title === activeChatTitle) return;
    void api("chats.rename", { chatId: activeChatId, title }).catch((error: unknown) =>
      errorToast("Failed to rename chat", error),
    );
  };
  // T45 removes the chat's VM, attachments and workspace itself. Deleting the open chat lands on
  // the Chat list.
  const deleteChat = async (chatId: ChatId) => {
    try {
      await api("chats.delete", { chatId });
    } catch (error) {
      // A chat already gone was deleted elsewhere meanwhile, so "Failed to delete chat" would
      // be a lie.
      if (!isNotFound(error)) errorToast("Failed to delete chat", error);
      return;
    }
    forgetChatDrafts(chatId);
    const params = router.state.matches.at(-1)?.params;
    if (params === undefined || !("chatId" in params) || params.chatId !== chatId) return;
    await router
      .navigate({ to: "/chats", replace: true })
      .catch(() =>
        toastManager.add({ type: "error", title: "Chat deleted, but navigation failed" }),
      );
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // The chevron is the explicit menu affordance; only the title text renames.
    if (event.target instanceof Element && event.target.closest("[data-chat-title-chevron]")) {
      return;
    }
    startRename();
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const actions = (
    <MenuPopup align="start">
      <MenuItem onClick={startRename}>
        <PencilIcon />
        Rename chat
      </MenuItem>
      <MenuItem disabled={compactDisabled} onClick={onCompactContext}>
        <ShrinkIcon />
        Compact conversation
      </MenuItem>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
        <Trash2Icon />
        Delete chat
      </MenuItem>
    </MenuPopup>
  );
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <ContextMenu disabled={renamingTitle !== null}>
          <ContextMenuTrigger className="flex min-w-0 flex-1">
            <PageBreadcrumb
              parent={<PageBreadcrumbLink to="/chats">Chat</PageBreadcrumbLink>}
              className="flex-1 overflow-clip [overflow-clip-margin:2px]"
              currentClassName="min-w-10 flex-1"
              title={
                renamingTitle !== null ? (
                  <input
                    autoFocus
                    aria-label="Chat title"
                    className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
                    defaultValue={renamingTitle}
                    onBlur={(event) => {
                      if (renameCommittedRef.current) return;
                      commitRename(event.currentTarget.value);
                    }}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={handleRenameKeyDown}
                  />
                ) : (
                  <Menu>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <MenuTrigger
                            aria-label={`Chat actions for ${activeChatTitle}`}
                            onDoubleClick={handleTitleDoubleClick}
                            render={
                              <button
                                type="button"
                                className="group/chat-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                              />
                            }
                          />
                        }
                      >
                        <h2 className="min-w-0">
                          <PageBreadcrumbText>{activeChatTitle}</PageBreadcrumbText>
                        </h2>
                        <ChevronDownIcon
                          aria-hidden
                          data-chat-title-chevron
                          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/chat-title:opacity-100 group-focus-visible/chat-title:opacity-100"
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{activeChatTitle}</TooltipPopup>
                    </Tooltip>
                    {actions}
                  </Menu>
                )
              }
            />
          </ContextMenuTrigger>
          {actions}
        </ContextMenu>
      </div>
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>{`Delete chat "${activeChatTitle}"?`}</DialogTitle>
            <DialogDescription>
              This permanently clears conversation history for this chat.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                void deleteChat(activeChatId);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </>
  );
}
