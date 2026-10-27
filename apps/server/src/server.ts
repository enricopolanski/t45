import { ChatService, layerTasks } from "./chats/ChatService.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { FetchHttpClient, HttpRouter } from "effect/http";

import { UserService } from "./org/UserService.ts";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";
import * as AttachmentRepository from "./attachments/AttachmentRepository.ts";
import * as ChatRepository from "./chats/ChatRepository.ts";
import * as AttachmentsHttp from "./attachments/http.ts";
import { AppRpcLayer } from "./AppRpc.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Authentication from "./auth/Authentication.ts";
import * as AuthHttp from "./auth/http.ts";
import * as WebhookRoute from "./automations/webhookRoute.ts";
import * as OrgHttp from "./org/http.ts";
import * as OrganizationRepository from "./org/OrganizationRepository.ts";
import * as AgentRepository from "./agents/AgentRepository.ts";
import * as SkillRepository from "./agents/SkillRepository.ts";
import * as NotificationRepository from "./workflows/NotificationRepository.ts";
import * as TicketRepository from "./workflows/TicketRepository.ts";
import * as WorkflowDefinitionRepository from "./workflows/WorkflowDefinitionRepository.ts";
import * as WorkflowRepository from "./workflows/WorkflowRepository.ts";
import * as WorkflowService from "./workflows/WorkflowService.ts";
import * as UserRepository from "./org/UserRepository.ts";
import * as AutomationService from "./automations/AutomationService.ts";
import * as ServerActivation from "./serverActivation.ts";

// Ids in paths can exceed find-my-way's 100-character default for one path segment.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// Held RPC streams are long-lived requests that a restart may cut: their clients
// retry. Do not add an artificial drain before their finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
    });
  }),
);

const layerStore = Layer.mergeAll(
  ChatRepository.layer,
  AttachmentRepository.layer,
  AgentRepository.layer,
  SkillRepository.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerConfig));

const layerWorkflowRepositories = Layer.mergeAll(
  WorkflowDefinitionRepository.layer,
  WorkflowRepository.layer,
  TicketRepository.layer,
  NotificationRepository.layer,
);

const layerChatServices = ChatService.layer.pipe(Layer.provideMerge(layerStore));

const layerOrg = OrganizationRepository.layer.pipe(
  Layer.provideMerge(layerWorkflowRepositories),
  Layer.provideMerge(UserRepository.layer),
  Layer.provideMerge(layerChatServices),
);

const layerRuntimeDependencies = Layer.effect(UserService, UserService.make).pipe(
  Layer.provide(Authentication.layer),
  Layer.provideMerge(WorkflowService.layer),
  Layer.provideMerge(AutomationService.layer),
  Layer.provideMerge(layerTasks),
  Layer.provideMerge(layerOrg),
);

const layerMakeRoutes = Layer.mergeAll(
  AuthHttp.layer,
  OrgHttp.layer,
  WebhookRoute.layer,
  AttachmentsHttp.layerAttachmentRoute,
  AttachmentsHttp.layerAttachmentUploadRoute,
  ServerHttp.layerStaticRoutes,
  AppRpcLayer,
).pipe(Layer.provide(ServerHttp.layerSameOrigin), Layer.provide(ServerHttp.layerHttpCompression));

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const layerStartup = Layer.effectDiscard(
      Effect.gen(function* () {
        const chats = yield* ChatService;
        yield* chats.start((yield* WorkflowService.WorkflowService).taskHooks);
      }),
    ).pipe(Layer.provideMerge(layerRuntimeDependencies));

    const layerRoutes = HttpRouter.serve(layerMakeRoutes, {
      disableLogger: !config.logRequests,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      Layer.tap(() =>
        Deferred.succeed(activation, undefined).pipe(
          Effect.andThen(
            Effect.logInfo("T45 server is ready", { host: config.host, port: config.port }),
          ),
        ),
      ),
    );
    return layerRoutes.pipe(
      Layer.provideMerge(layerHttpServer),
      Layer.provideMerge(layerStartup),
      Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation))),
      Layer.provide(Logger.layer([Logger.consolePretty()])),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

// bin.ts supplies configuration.
export const runServer = Layer.launch(layerMakeServer).pipe(Effect.withTracerEnabled(false));
