import { Authorization, CurrentUser } from "@t45/contracts/auth/Authorization";
import { Notifications } from "@t45/contracts/resources/Notifications";
import * as Effect from "effect/Effect";

import { NotificationRepository } from "./NotificationRepository.ts";
import { WorkflowService } from "./WorkflowService.ts";

export const layer = Notifications.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    const notifications = yield* NotificationRepository;
    return Notifications.of({
      "notifications.list": () =>
        Effect.flatMap(CurrentUser, ({ userId }) => workflows.listNotifications(userId)),
      "notifications.markRead": ({ notificationId }) =>
        Effect.flatMap(CurrentUser, ({ userId }) =>
          workflows.markNotificationRead(userId, notificationId),
        ),
      "notifications.remove": ({ notificationId }) =>
        Effect.flatMap(CurrentUser, ({ userId }) => notifications.remove(notificationId, userId)),
    });
  }),
);
