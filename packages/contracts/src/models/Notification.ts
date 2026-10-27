import * as Schema from "effect/Schema";

import { StringId, makeId } from "./primitives.ts";

export const NotificationId = makeId("NotificationId");
export type NotificationId = typeof NotificationId.Type;

/**
 * Why something landed in My work: a step to do, an approval, a rejection, or a failed agent's
 * step; or, for a workflow's admins, a workflow that needs a new responsible or names a
 * deactivated person.
 */
export const NotificationKind = Schema.Literals([
  "to_do",
  "to_approve",
  "rejected",
  "agent_failed",
  "needs_responsible",
  "names_deactivated",
]);
export type NotificationKind = typeof NotificationKind.Type;

/** Step notices identify a step; administrative notices identify the workflow alone. */
export const hasValidTarget = (notice: {
  readonly kind: NotificationKind;
  readonly stepId: string | null;
}) =>
  notice.kind === "needs_responsible" || notice.kind === "names_deactivated"
    ? notice.stepId === null
    : notice.stepId !== null;

export class Notification extends Schema.Opaque<Notification>()(
  Schema.Struct({
    id: NotificationId,
    kind: NotificationKind,
    /** The step it opens; null for a notice about a whole workflow. */
    stepId: Schema.NullOr(StringId),
    workflowId: StringId,
    isRead: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromString,
  }).check(
    Schema.makeFilter(hasValidTarget, {
      expected: "a step for work notifications, or no step for workflow notices",
    }),
  ),
) {}
