// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as RcMap from "effect/RcMap";
import * as References from "effect/References";
import type * as Types from "effect/Types";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AppRpc from "./AppRpc.ts";
import * as BuiltIns from "./BuiltIns.ts";
import * as AgentRepository from "./agents/AgentRepository.ts";
import * as SkillRepository from "./agents/SkillRepository.ts";
import * as AttachmentRepository from "./attachments/AttachmentRepository.ts";
import * as AttachmentsHttp from "./attachments/http.ts";
import * as Authentication from "./auth/Authentication.ts";
import * as AuthHttp from "./auth/http.ts";
import * as AutomationRepository from "./automations/AutomationRepository.ts";
import * as CapabilityRepository from "./capabilities/CapabilityRepository.ts";
import * as ChatRepository from "./chats/ChatRepository.ts";
import { ChatService } from "./chats/ChatService.ts";
import * as ServerConfig from "./config.ts";
import * as HttpServer from "./http.ts";
import * as OrgHttp from "./org/http.ts";
import * as OrganizationRepository from "./org/OrganizationRepository.ts";
import * as UserRepository from "./org/UserRepository.ts";
import { UserService } from "./org/UserService.ts";
import * as CommandLogRepository from "./persistence/CommandLogRepository.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { RunnerService } from "./runner/RunnerService.ts";
import * as NotificationRepository from "./workflows/NotificationRepository.ts";
import * as TicketRepository from "./workflows/TicketRepository.ts";
import * as WorkflowRepository from "./workflows/WorkflowRepository.ts";
import * as ProjectRepository from "./workflows/ProjectRepository.ts";
import * as WorkflowService from "./workflows/WorkflowService.ts";

const Store = BuiltIns.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      UserRepository.layer,
      ChatRepository.layer,
      AttachmentRepository.layer,
      AgentRepository.layer,
      SkillRepository.layer,
      CapabilityRepository.layer,
    ).pipe(Layer.provideMerge(SqlitePersistence.layer)),
  ),
);

const WorkflowRepositories = Layer.mergeAll(
  WorkflowRepository.layer,
  ProjectRepository.layer,
  TicketRepository.layer,
  NotificationRepository.layer,
  CommandLogRepository.layer,
);

const ChatServices = ChatService.layer.pipe(
  Layer.provideMerge(RunnerService.layer),
  Layer.provideMerge(WorkflowRepositories),
  Layer.provideMerge(Store),
);

const Org = OrganizationRepository.layer.pipe(Layer.provideMerge(ChatServices));

/**
 * Groups the resources and services owned by one isolated app instance.
 * They get built afresh under a common separate data instance:
 * database, session state, execution state, background jobs
 */
const InstanceDependencies = Layer.effect(UserService, UserService.make).pipe(
  Layer.provide(Authentication.layer),
  Layer.provideMerge(WorkflowService.layer),
  Layer.provideMerge(AutomationRepository.layer),
  Layer.provideMerge(Org),
);

const Routes = Layer.mergeAll(
  AuthHttp.layer,
  OrgHttp.layer,
  AttachmentsHttp.layer,
  HttpServer.layer,
  AppRpc.layer,
);

const makeInstance = (dataDir: string, instanceId: string) =>
  // `fresh` builds the instance layer ex-novo, doesn't reuse existing
  Layer.build(Layer.fresh(InstanceDependencies)).pipe(
    Effect.flatMap((services) =>
      HttpRouter.toHttpEffect(Layer.fresh(Routes)).pipe(
        Effect.map(Effect.provideContext(services)),
        Effect.provideContext(services),
      ),
    ),
    Effect.provide(
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({ DATA_DIR: dataDir, TOOL_INSTANCE: instanceId }),
        {
          asPrimary: true,
        },
      ),
    ),
  );

/** Development only: serves a request carrying `x-instance-id` from that instance. */
const makeInstanceMiddleware = Effect.gen(function* () {
  const instancesDir = yield* ServerConfig.instancesDir;
  const instances = yield* RcMap.make({
    lookup: (instanceId: string) => makeInstance(`${instancesDir}/${instanceId}`, instanceId),
    idleTimeToLive: "10 minutes",
  });
  return (defaultInstance: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const instanceId = request.headers["x-instance-id"];
      if (instanceId === undefined) return yield* defaultInstance;
      if (/^[\w-]{1,128}$/u.test(instanceId)) {
        return yield* Effect.flatten(RcMap.get(instances, instanceId));
      }
      return HttpServerResponse.text("Invalid x-instance-id", { status: 400 });
    });
});

const Server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* ServerConfig.host;
    const port = yield* ServerConfig.port;
    const logLevel = yield* ServerConfig.logLevel;
    const logRequests = yield* ServerConfig.logRequests;

    const ServedRoutes = Layer.unwrap(
      Effect.gen(function* () {
        const environment = yield* ServerConfig.environment;
        const InstanceMiddleware = HttpRouter.middleware(makeInstanceMiddleware, { global: true });
        return HttpRouter.serve(
          environment._tag === "development" ? Layer.merge(Routes, InstanceMiddleware) : Routes,
          { disableLogger: !logRequests },
        );
      }),
    ).pipe(Layer.tap(() => Effect.logInfo("T45 server is ready", { host, port })));
    return ServedRoutes.pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), {
          host,
          port,
          gracefulShutdownTimeout: 0,
        }),
      ),
      Layer.provideMerge(InstanceDependencies),
      Layer.provide(Logger.layer([Logger.consolePretty()])),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
      Layer.provide(Layer.succeed(HttpRouter.RouterConfig, { maxParamLength: 512 })),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(Server).pipe(Effect.withTracerEnabled(false)));
