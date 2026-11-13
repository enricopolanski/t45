import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Chat, Refused as ChatRefused, Report } from "../models/Chat.ts";
import { Refused as AutomationRefused, Automation, AutomationId } from "../models/Automation.ts";
import { AdminOnly } from "../Authorization.ts";
import { AccessDenied, NotFound } from "./errors.ts";

const Settings = Struct.pick(Automation.fields, ["title", "prompt", "agentId"]);
const Errors = Schema.Union([AutomationRefused, NotFound, AccessDenied]);

export const AutomationSummary = Schema.Struct({
  ...Automation.fields,
  lastRun: Schema.NullOr(
    Schema.Struct({
      statusLabel: Schema.String,
      at: Chat.fields.lastActivityAt,
      latestReport: Schema.NullOr(Report),
    }),
  ),
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
        Schema.Struct(Struct.pick(Automation.fields, ["id", "title", "prompt", "agentId"])),
      ),
      error: AccessDenied,
    }),
  )
  .prefix("automations.");
