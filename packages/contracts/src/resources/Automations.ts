import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ChatId, Refused as ChatRefused, Report } from "../models/Chat.ts";
import { PhaseNumber, RunStatus } from "../models/ChatOrigin.ts";
import { StringId } from "../models/primitives.ts";
import {
  Refused as AutomationRefused,
  Automation,
  AutomationId,
  Phase,
} from "../models/Automation.ts";
import { AdminOnly } from "../Authorization.ts";
import { AccessDenied, NotFound } from "./errors.ts";

const Settings = Struct.pick(Automation.fields, [
  "title",
  "prompt",
  "agentId",
  "stepContext",
  "firstPhaseTitle",
  "nextPhases",
]);
const Errors = Schema.Union([AutomationRefused, NotFound, AccessDenied]);

export const AutomationRun = Schema.Struct({
  /** The chat it runs in. */
  chatId: ChatId,
  /** The step it ran on; null for a run started from settings. */
  stepId: Schema.NullOr(StringId),
  ranBy: StringId,
  /** Whether entering its step started it, rather than a member. */
  isAutomatic: Schema.Boolean,
  /** Which of its automation's phases it ran, from 1. */
  phase: PhaseNumber,
  startedAt: Schema.DateTimeUtcFromString,
  /** Null while it runs. */
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  status: RunStatus,
  latestReport: Schema.NullOr(Report),
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationSummary = Schema.Struct({
  ...Automation.fields,
  /** Newest first. */
  runs: Schema.Array(AutomationRun),
});
export type AutomationSummary = typeof AutomationSummary.Type;

export const Automations = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(AutomationSummary) }),
  Rpc.make("watch", { success: Schema.Array(AutomationSummary), stream: true }),
  Rpc.make("create", {
    payload: Settings,
    success: Automation,
    error: Schema.Union([AutomationRefused, AccessDenied]),
  }),
  Rpc.make("runNow", {
    payload: { id: AutomationId },
    error: Schema.Union([AutomationRefused, ChatRefused, NotFound, AccessDenied]),
  }),
  Rpc.make("update", {
    payload: { id: AutomationId, ...Settings },
    success: Automation,
    error: Errors,
  }),
  /** For good: it starts no new run; a run under way finishes. */
  Rpc.make("archive", { payload: { id: AutomationId }, error: NotFound }),
)
  // Middleware applies only to existing RPCs; adding listForSteps afterward keeps it member-accessible.
  .middleware(AdminOnly)
  .add(
    Rpc.make("listForSteps", {
      success: Schema.Array(
        Schema.Struct({
          ...Struct.pick(Automation.fields, [
            "id",
            "title",
            "prompt",
            "agentId",
            "firstPhaseTitle",
          ]),
          /** The phases after the first, by name only. */
          nextPhases: Schema.Array(Schema.Struct(Struct.pick(Phase.fields, ["title"]))),
        }),
      ),
      error: AccessDenied,
    }),
  )
  .prefix("automations.");
