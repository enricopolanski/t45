// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as Executions from "./Executions.ts";
import * as RunnerHttp from "./http.ts";
import * as Microsandbox from "./Microsandbox.ts";
import * as RunnerConfig from "./RunnerConfig.ts";

const layer = HttpRouter.serve(RunnerHttp.layer).pipe(
  Layer.provide(Executions.layer),
  Layer.provide(Microsandbox.layer),
  Layer.provide(
    NodeHttpServer.layerConfig(() => NodeHttp.createServer(), {
      host: RunnerConfig.host,
      port: RunnerConfig.port,
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

NodeRuntime.runMain(Layer.launch(layer).pipe(Effect.withTracerEnabled(false)));
