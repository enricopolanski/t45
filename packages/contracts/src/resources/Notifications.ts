import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { Notification, NotificationId, hasValidTarget } from "../models/Notification.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "../models/primitives.ts";
import { NotFound } from "./errors.ts";

export const NotificationView = Schema.Struct({
  ...Notification.fields,
  workflowName: TrimmedNonEmptyString,
  ticketTitle: Schema.NullOr(TrimmedNonEmptyString),
  stepName: Schema.NullOr(TrimmedNonEmptyString),
}).check(Schema.makeFilter(hasValidTarget));
export type NotificationView = typeof NotificationView.Type;

export const Notifications = RpcGroup.make(
  Rpc.make("list", {
    success: Schema.Struct({
      unread: NonNegativeInt,
      notifications: Schema.Array(NotificationView),
    }),
  }),
  Rpc.make("markRead", { payload: { notificationId: NotificationId }, error: NotFound }),
).prefix("notifications.");
