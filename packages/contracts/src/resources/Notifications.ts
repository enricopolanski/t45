import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { Notification, NotificationId, hasValidTarget } from "../models/Notification.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "../models/primitives.ts";
import { AccessDenied, NotFound } from "./errors.ts";

export const NotificationView = Schema.Struct({
  ...Notification.fields,
  projectName: TrimmedNonEmptyString,
  ticketTitle: Schema.NullOr(TrimmedNonEmptyString),
  stepName: Schema.NullOr(TrimmedNonEmptyString),
}).check(Schema.makeFilter(hasValidTarget));
export type NotificationView = typeof NotificationView.Type;

export const Notifications = RpcGroup.make(
  Rpc.make("list", {
    error: AccessDenied,
    success: Schema.Struct({
      unread: NonNegativeInt,
      notifications: Schema.Array(NotificationView),
    }),
  }),
  Rpc.make("markRead", {
    payload: { notificationId: NotificationId },
    error: Schema.Union([NotFound, AccessDenied]),
  }),
).prefix("notifications.");
