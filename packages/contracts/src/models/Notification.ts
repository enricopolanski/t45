import * as Schema from "effect/Schema";

import { StringId, makeId } from "./primitives.ts";

export const NotificationId = makeId("NotificationId");
export type NotificationId = typeof NotificationId.Type;

/**
 * Why something landed in My work: a step to do or a step whose automation ended; or, for a project's
 * admins, a project that names a deactivated person as a step's assignee on entry.
 */
export const NotificationKind = Schema.Literals(["to_do", "automation_ended", "names_deactivated"]);
export type NotificationKind = typeof NotificationKind.Type;

/** Step notices identify a step; administrative notices identify the project alone. */
export const hasValidTarget = (notice: {
  readonly kind: NotificationKind;
  readonly stepId: string | null;
}) => (notice.kind === "names_deactivated" ? notice.stepId === null : notice.stepId !== null);

export class Notification extends Schema.Opaque<Notification>()(
  Schema.Struct({
    id: NotificationId,
    kind: NotificationKind,
    /** The step it opens; null for a notice about a whole project. */
    stepId: Schema.NullOr(StringId),
    projectId: StringId,
    isRead: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromString,
  }).check(
    Schema.makeFilter(hasValidTarget, {
      expected: "a step for work notifications, or no step for project notices",
    }),
  ),
) {}
