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

import { makeExecutions } from "./ExecutionOrchestrator.ts";
import * as SandboxManager from "./SandboxManager.ts";
import { makeScripts } from "./Scripts.ts";

const handlers = RunnerRpcs.toLayer(
  Effect.gen(function* () {
    return RunnerRpcs.of({
      ...(yield* makeScripts),
      ...(yield* makeExecutions),
      // Microsandbox VMs reach the server themselves, so this runner relays no requests.
      respond: () => Effect.void,
    });
  }),
).pipe(Layer.provide(SandboxManager.layer));

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
  // Binary, so a VM disk travels as bytes: JSON's base64 for one of a few hundred MB exhausts the heap.
  Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: "unbounded" })),
  Layer.provide(handlers),
  Layer.provide(
    NodeHttpServer.layerConfig(() => NodeHttp.createServer(), {
      host: Config.schema(Schema.NonEmptyString, "T45_RUNNER_HOST"),
      port: Config.Port("T45_RUNNER_PORT"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

NodeRuntime.runMain(Layer.launch(layer).pipe(Effect.withTracerEnabled(false)));
