// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as Executions from "./Executions.ts";
import * as RunnerHttp from "./http.ts";
import * as Microsandbox from "./Microsandbox.ts";
import * as ModelCatalog from "./ModelCatalog.ts";
import * as RunnerConfig from "./RunnerConfig.ts";

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RunnerConfig.RunnerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.port,
    });
  }),
);

export const layer = HttpRouter.serve(RunnerHttp.layer).pipe(
  Layer.provide(Executions.layer),
  Layer.provide(ModelCatalog.layer),
  Layer.provide(Microsandbox.layer),
  Layer.provideMerge(layerHttpServer),
  Layer.provideMerge(RunnerConfig.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);
