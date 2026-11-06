// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { FetchHttpClient, HttpRouter } from "effect/http";

import { AppRpcLayer } from "./AppRpc.ts";
import * as AgentRepository from "./agents/AgentRepository.ts";
import * as SkillRepository from "./agents/SkillRepository.ts";
import * as AttachmentRepository from "./attachments/AttachmentRepository.ts";
import * as AttachmentsHttp from "./attachments/http.ts";
import * as Authentication from "./auth/Authentication.ts";
import * as AuthHttp from "./auth/http.ts";
import * as AutomationService from "./automations/AutomationService.ts";
import * as WebhookRoute from "./automations/webhookRoute.ts";
import * as ChatRepository from "./chats/ChatRepository.ts";
import { ChatService } from "./chats/ChatService.ts";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";
import * as OrgHttp from "./org/http.ts";
import * as OrganizationRepository from "./org/OrganizationRepository.ts";
import * as UserRepository from "./org/UserRepository.ts";
import { UserService } from "./org/UserService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { RunnerService } from "./runner/RunnerService.ts";
import * as ServerActivation from "./serverActivation.ts";
import { TaskService } from "./tasks/TaskService.ts";
import * as NotificationRepository from "./workflows/NotificationRepository.ts";
import * as TicketRepository from "./workflows/TicketRepository.ts";
import * as WorkflowDefinitionRepository from "./workflows/WorkflowDefinitionRepository.ts";
import * as WorkflowRepository from "./workflows/WorkflowRepository.ts";
import * as WorkflowService from "./workflows/WorkflowService.ts";

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

const layerChatServices = ChatService.layer.pipe(
  Layer.provideMerge(RunnerService.layer),
  Layer.provideMerge(layerWorkflowRepositories),
  Layer.provideMerge(layerStore),
);

const layerOrg = OrganizationRepository.layer.pipe(
  Layer.provideMerge(UserRepository.layer),
  Layer.provideMerge(layerChatServices),
);

const layerRuntimeDependencies = Layer.effect(UserService, UserService.make).pipe(
  Layer.provide(Authentication.layer),
  Layer.provideMerge(WorkflowService.layer),
  Layer.provideMerge(AutomationService.layer),
  Layer.provideMerge(TaskService.layer),
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
    const host = yield* ServerConfig.host;
    const port = yield* ServerConfig.port;
    const logLevel = yield* ServerConfig.logLevel;
    const logRequests = yield* ServerConfig.logRequests;
    const activation = yield* Deferred.make<void>();

    const layerRoutes = HttpRouter.serve(layerMakeRoutes, {
      disableLogger: !logRequests,
      routerConfig: { maxParamLength: 512 },
    }).pipe(
      Layer.tap(() =>
        Deferred.succeed(activation, undefined).pipe(
          Effect.andThen(Effect.logInfo("T45 server is ready", { host, port })),
        ),
      ),
    );
    return layerRoutes.pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), {
          host,
          port,
          gracefulShutdownTimeout: 0,
        }),
      ),
      Layer.provideMerge(layerRuntimeDependencies),
      Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation))),
      Layer.provide(Logger.layer([Logger.consolePretty()])),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(layerMakeServer).pipe(Effect.withTracerEnabled(false)));
