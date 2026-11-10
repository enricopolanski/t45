import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { type Agent, canUse } from "./Agent.ts";
import { makeId, StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";
import { canManageUsers, type Role, type State } from "./User.ts";

export const AutomationId = makeId("AutomationId");
export type AutomationId = typeof AutomationId.Type;

export class Automation extends Schema.Opaque<Automation>()(
  Schema.Struct({
    id: AutomationId,
    title: Title,
    prompt: TrimmedNonEmptyString,
    /** The agent each run talks to, in a new chat per run. */
    agentId: StringId,
    /** Archived for good: it runs no more, by hand or on a step. */
    isArchived: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/** Whether `member` may run an automation of `agent` now: an active admin who can use the agent. */
export const canRun = (
  member: { readonly userId: string; readonly role: Role; readonly state: State },
  agent: Pick<Agent, "status" | "creatorUserId" | "isPublished"> | null,
) =>
  canManageUsers(member) &&
  agent !== null &&
  agent.status === "active" &&
  canUse(agent, member.userId);

const REFUSALS = {
  agent_unavailable:
    "This agent is archived or private to someone else. Choose an active agent you can use.",
  attached_agent_unfit:
    "A workflow step runs this automation, so its agent must work on steps and, while private, belong to you and that workflow's creator.",
};

export class Refused extends Schema.TaggedError<Refused>()("AutomationRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
  }
}
