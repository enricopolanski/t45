import type { NotificationKind } from "@t45/contracts/models/Notification";
import type { NotificationView } from "@t45/contracts/resources/Notifications";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { useApiQuery } from "../../state/rpc";
import { notifications } from "../../state/work";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  to_do: "New step to do",
  to_approve: "Waiting for your approval",
  rejected: "Changes needed",
  agent_failed: "An agent couldn't finish",
  needs_responsible: "Needs a new responsible",
  names_deactivated: "Names someone who left",
};

/**
 * What landed in my My work. The count is re-read on a timer, on focus, and whenever this
 * browser changes work; opening a notification opens its step, which reads it.
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: inbox, error, refresh } = useApiQuery(notifications);
  const unread = inbox?.unread ?? 0;

  const openNotification = (notification: NotificationView) => {
    setOpen(false);
    if (notification.stepId !== null) {
      void navigate({ to: "/my-work/$stepId", params: { stepId: notification.stepId } });
      return;
    }
    // A notice about a whole workflow opens its editor, where it gets fixed.
    if (!notification.isRead) {
      void api("notifications.markRead", { notificationId: notification.id }).then(
        refresh,
        () => undefined,
      );
    }
    void navigate({
      to: "/workflows/$workflowId/edit",
      params: { workflowId: notification.workflowId },
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          />
        }
      >
        <BellIcon />
        {unread > 0 ? (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" aria-label="Notifications" width="md">
        <PopoverTitle>Notifications</PopoverTitle>
        {error !== null ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {inbox !== null && inbox.notifications.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing new.</p>
        ) : null}
        <ul className="mt-2 flex max-h-96 flex-col overflow-y-auto">
          {inbox?.notifications.map((notification) => (
            <li key={notification.id}>
              <button
                type="button"
                onClick={() => openNotification(notification)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-muted"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {notification.isRead ? null : (
                    <span aria-label="Unread" className="size-1.5 rounded-full bg-primary" />
                  )}
                  {NOTIFICATION_LABELS[notification.kind]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[notification.ticketTitle, notification.stepName, notification.workflowName]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
