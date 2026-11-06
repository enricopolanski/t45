// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as ExecutionOrchestrator from "./ExecutionOrchestrator.ts";

/** Only T45 calls the runner, with its bearer token. */
const routes = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), "T45_RUNNER_TOKEN");
    const rpc = yield* RpcServer.toHttpEffect(RunnerRpcs, {
      disableTracing: true,
      disableFatalDefects: true,
    });
    return HttpRouter.add(
      "POST",
      "/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(token)}`) {
          return HttpServerResponse.empty({ status: 401 });
        }
        return yield* rpc;
      }),
    );
  }),
);

const layer = HttpRouter.serve(routes).pipe(
  Layer.provide(RpcSerialization.layerNdjsonWith({ maxBufferSize: "unbounded" })),
  Layer.provide(ExecutionOrchestrator.layer),
  Layer.provide(
    NodeHttpServer.layerConfig(() => NodeHttp.createServer(), {
      host: Config.schema(Schema.NonEmptyString, "T45_RUNNER_HOST"),
      port: Config.Port("T45_RUNNER_PORT"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

NodeRuntime.runMain(Layer.launch(layer).pipe(Effect.withTracerEnabled(false)));
