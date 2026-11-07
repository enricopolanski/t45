// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as AppRpc from "./AppRpc.ts";
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
import * as HttpServer from "./http.ts";
import * as OrgHttp from "./org/http.ts";
import * as OrganizationRepository from "./org/OrganizationRepository.ts";
import * as UserRepository from "./org/UserRepository.ts";
import { UserService } from "./org/UserService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { RunnerService } from "./runner/RunnerService.ts";
import { TaskService } from "./tasks/TaskService.ts";
import * as NotificationRepository from "./workflows/NotificationRepository.ts";
import * as TicketRepository from "./workflows/TicketRepository.ts";
import * as WorkflowDefinitionRepository from "./workflows/WorkflowDefinitionRepository.ts";
import * as WorkflowRepository from "./workflows/WorkflowRepository.ts";
import * as WorkflowService from "./workflows/WorkflowService.ts";

const Store = Layer.mergeAll(
  UserRepository.layer,
  ChatRepository.layer,
  AttachmentRepository.layer,
  AgentRepository.layer,
  SkillRepository.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layer));

const WorkflowRepositories = Layer.mergeAll(
  WorkflowDefinitionRepository.layer,
  WorkflowRepository.layer,
  TicketRepository.layer,
  NotificationRepository.layer,
);

const ChatServices = ChatService.layer.pipe(
  Layer.provideMerge(RunnerService.layer),
  Layer.provideMerge(WorkflowRepositories),
  Layer.provideMerge(Store),
);

const Org = OrganizationRepository.layer.pipe(Layer.provideMerge(ChatServices));

const RuntimeDependencies = Layer.effect(UserService, UserService.make).pipe(
  Layer.provide(Authentication.layer),
  Layer.provideMerge(WorkflowService.layer),
  Layer.provideMerge(AutomationService.layer),
  Layer.provideMerge(TaskService.layer),
  Layer.provideMerge(Org),
);

const Routes = Layer.mergeAll(
  AuthHttp.layer,
  OrgHttp.layer,
  WebhookRoute.layer,
  AttachmentsHttp.layer,
  HttpServer.layer,
  AppRpc.layer,
);

const Server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* ServerConfig.host;
    const port = yield* ServerConfig.port;
    const logLevel = yield* ServerConfig.logLevel;
    const logRequests = yield* ServerConfig.logRequests;

    const ServedRoutes = HttpRouter.serve(Routes, {
      disableLogger: !logRequests,
      routerConfig: { maxParamLength: 512 },
    }).pipe(Layer.tap(() => Effect.logInfo("T45 server is ready", { host, port })));
    return ServedRoutes.pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), {
          host,
          port,
          gracefulShutdownTimeout: 0,
        }),
      ),
      Layer.provideMerge(RuntimeDependencies),
      Layer.provide(Logger.layer([Logger.consolePretty()])),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(Server).pipe(Effect.withTracerEnabled(false)));
