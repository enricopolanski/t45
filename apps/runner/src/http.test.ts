import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import * as RunnerHttp from "./http.ts";
import * as Fixture from "./Runner.testkit.ts";

const layer = HttpRouter.serve(RunnerHttp.layer).pipe(
  Layer.provide([Fixture.layerExecutions, Fixture.layerConfig]),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

it.effect("Only T45's token reaches the runner", () =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const status = (headers: Record<string, string>) =>
      http.post("/rpc", { headers }).pipe(Effect.map((response) => response.status));
    assert.strictEqual(yield* status({}), 401);
    assert.strictEqual(yield* status({ authorization: "Bearer wrong" }), 401);
    const runner = yield* RpcClient.make(RunnerRpcs).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({
          url: "",
          transformClient: HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.appendUrl("/rpc"),
              HttpClientRequest.bearerToken("secret-token"),
            ),
          ),
        }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
      ),
    );
    assert.deepEqual(yield* runner.getModels(), [{ slug: "opencode-go/glm-5.3", name: "glm-5.3" }]);
  }).pipe(Effect.provide(layer)),
);
