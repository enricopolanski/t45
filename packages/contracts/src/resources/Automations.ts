import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ChatId, Refused as ChatRefused } from "../models/Chat.ts";
import { Refused as AutomationRefused, Automation, AutomationId } from "../models/Automation.ts";
import { AdminOnly } from "../Authorization.ts";
import { NotFound } from "./errors.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";

const Settings = Struct.pick(Automation.fields, [
  "title",
  "prompt",
  "agentId",
  "isEnabled",
  "schedule",
]);

export const Automations = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(Automation) }),
  Rpc.make("create", {
    payload: Settings,
    success: Automation,
    error: AutomationRefused,
  }),
  Rpc.make("rotateToken", {
    payload: { id: AutomationId },
    success: Automation,
    error: Schema.Union([AutomationRefused, NotFound]),
  }),
  Rpc.make("runNow", {
    payload: { id: AutomationId },
    success: Schema.Struct({ chatId: ChatId }),
    error: Schema.Union([AutomationRefused, ChatRefused, NotFound]),
  }),
  /** Flips only the enabled flag, never overwriting the automation's other fields. */
  Rpc.make("setEnabled", {
    payload: { id: AutomationId, isEnabled: Schema.Boolean },
    success: Automation,
    error: NotFound,
  }),
  Rpc.make("update", {
    payload: { id: AutomationId, ...Settings },
    success: Automation,
    error: Schema.Union([AutomationRefused, NotFound]),
  }),
)
  .prefix("automations.")
  .middleware(AdminOnly);
