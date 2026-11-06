import { RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { RpcClient, RpcSerialization } from "effect/rpc";

const make = RpcClient.make(RunnerRpcs);

export class RunnerService extends Context.Service<RunnerService, Effect.Success<typeof make>>()(
  "t45/runner/RunnerService",
) {
  static get layer() {
    return layer;
  }
}

const layer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.schema(Schema.NonEmptyString, "RUNNER_URL");
    const token = yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), "RUNNER_TOKEN");
    return Layer.effect(RunnerService, make).pipe(
      Layer.provide(
        RpcClient.layerProtocolHttp({
          url: `${url.replace(/\/+$/u, "")}/rpc`,
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjsonWith({ maxBufferSize: "unbounded" })),
    );
  }),
);
