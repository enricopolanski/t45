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

import * as BlobStore from "./attachments/BlobStore.ts";
import * as BuiltIns from "./BuiltIns.ts";
import * as ServerConfig from "./config.ts";
import * as HttpServer from "./http.ts";
import * as ChatDisks from "./chats/ChatDisks.ts";
import * as Restarts from "./chats/Restarts.ts";
import * as Instance from "./Instance.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as OwnApi from "./runner/OwnApi.ts";

/**
 * An instance keeps its database, chat disks and attachments in its data directory (attachments in
 * a bucket when one is configured), applies the built-ins file at every start, and answers relayed
 * agent requests over loopback.
 */
const InstanceDependencies = Instance.Dependencies.pipe(
  Layer.provideMerge(SqlitePersistence.layer),
  Layer.provide(
    Layer.mergeAll(
      BlobStore.layer,
      BuiltIns.layerFile,
      ChatDisks.layerDirectory,
      OwnApi.layerLoopback,
      Restarts.layerNode,
    ),
  ),
);

const Routes = Layer.merge(Instance.ApiRoutes, HttpServer.clientLayer);

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
