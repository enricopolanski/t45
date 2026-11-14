import { RpcApi } from "@t45/contracts/resources/RpcApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as AgentsHandlers from "./agents/Agents.handlers.ts";
import * as SkillsHandlers from "./agents/Skills.handlers.ts";
import * as CapabilitiesHandlers from "./capabilities/Capabilities.handlers.ts";
import { AdminOnly, Authorization } from "./auth/Authorization.ts";
import * as ChatsHandlers from "./chats/Chats.handlers.ts";
import * as CollectionsHandlers from "./collections/Collections.handlers.ts";
import * as OrganizationHandlers from "./org/Organization.handlers.ts";
import * as UsersHandlers from "./org/Users.handlers.ts";
import * as AutomationsHandlers from "./automations/Automations.handlers.ts";
import * as AssignmentsHandlers from "./workflows/Assignments.handlers.ts";
import * as NotificationsHandlers from "./workflows/Notifications.handlers.ts";
import * as WorkflowsHandlers from "./workflows/Workflows.handlers.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcServer.toHttpEffect(RpcApi, {
      disableTracing: true,
      disableFatalDefects: true,
    });
    return HttpRouter.add("POST", "/api/rpc", rpc);
  }),
).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(
    Layer.mergeAll(
      SkillsHandlers.layer,
      CapabilitiesHandlers.layer,
      AgentsHandlers.layer,
      UsersHandlers.layer,
      OrganizationHandlers.layer,
      ChatsHandlers.layer,
      AutomationsHandlers.layer,
      WorkflowsHandlers.layer,
      AssignmentsHandlers.layer,
      NotificationsHandlers.layer,
      CollectionsHandlers.layer,
      Authorization.layer,
      AdminOnly.layer,
    ),
  ),
);
