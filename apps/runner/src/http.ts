import { RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as RunnerConfig from "./RunnerConfig.ts";

/** Only T45 calls the runner, with its bearer token. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* RunnerConfig.token;
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
).pipe(Layer.provide(RpcSerialization.layerNdjson));
