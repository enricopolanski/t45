import { type Message, useTranslation } from "~/i18n/locale";
import type { NotificationId, NotificationKind } from "@t45/contracts/models/Notification";
import type { NotificationView } from "@t45/contracts/resources/Notifications";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon, CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../../rpc/api";
import { toastFailure } from "../../state/query";
import { useApiQuery } from "../../state/rpc";
import { notifications } from "../../state/work";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NOTIFICATION_LABELS: Record<NotificationKind, Message> = {
  to_do: "New step to do",
  automation_ended: "Automation ended",
  names_deactivated: "Names someone who left",
};

export function NotificationBell() {
  const t = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: inbox, error, refresh } = useApiQuery(notifications);
  const unread = inbox?.unread ?? 0;

  const updateNotification = (
    action: "notifications.markRead" | "notifications.remove",
    notificationId: NotificationId,
  ) => {
    void api(action, { notificationId }).then(refresh, (cause: unknown) =>
      toastFailure(t("Couldn't update notification"), cause),
    );
  };

  const openNotification = (notification: NotificationView) => {
    setOpen(false);
    if (!notification.isRead) {
      updateNotification("notifications.markRead", notification.id);
    }
    if (notification.stepId !== null) {
      void navigate({ to: "/my-work/$stepId", params: { stepId: notification.stepId } });
      return;
    }
    // A notice about a whole project opens its editor, where it gets fixed.
    void navigate({
      to: "/settings/projects/$projectId/edit",
      params: { projectId: notification.projectId },
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
            aria-label={unread > 0 ? t("Notifications, {0} unread", unread) : t("Notifications")}
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
      <PopoverPopup align="end" aria-label={t("Notifications")} width="md">
        <PopoverTitle>{t("Notifications")}</PopoverTitle>
        {error && <ErrorText className="mt-2" text={error} />}
        {inbox?.notifications.length === 0 ? (
          <p className="mt-2 py-5 text-center text-sm text-muted-foreground">
            {t("No notifications")}
          </p>
        ) : (
          <ul className="mt-2 flex max-h-96 flex-col overflow-y-auto">
            {inbox?.notifications.map((notification) => (
              <li
                key={notification.id}
                className="flex items-start rounded-md pr-1 hover:bg-muted focus-within:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => openNotification(notification)}
                  className="focus-ring relative flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md py-2 pr-2 pl-5 text-left wrap-anywhere"
                >
                  <span className="text-sm font-medium">
                    {notification.isRead ? null : (
                      <>
                        <span
                          aria-hidden
                          className="absolute top-4 left-2 size-1.5 rounded-full bg-primary"
                        />
                        <span className="sr-only">{t("Unread")} </span>
                      </>
                    )}
                    {t(NOTIFICATION_LABELS[notification.kind])}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[notification.ticketTitle, notification.stepName, notification.projectName]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                </button>
                <div className="mt-1 flex shrink-0 gap-1">
                  {notification.isRead ? null : (
                    <Tooltip>
                      <TooltipTrigger
                        render={<Button variant="ghost-muted" size="icon-sm" />}
                        aria-label={t("Mark as read")}
                        onClick={() =>
                          updateNotification("notifications.markRead", notification.id)
                        }
                      >
                        <CheckIcon />
                      </TooltipTrigger>
                      <TooltipPopup>{t("Mark as read")}</TooltipPopup>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={<Button variant="ghost-muted" size="icon-sm" />}
                      aria-label={t("Remove notification")}
                      onClick={() => updateNotification("notifications.remove", notification.id)}
                    >
                      <XIcon />
                    </TooltipTrigger>
                    <TooltipPopup>{t("Remove notification")}</TooltipPopup>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}
