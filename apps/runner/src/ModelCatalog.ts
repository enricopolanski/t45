/*
 * The models agents can run on: what OpenCode Go lists, as OpenCode slugs (`opencode-go/glm-5.3`).
 * Read with the runner's own key and kept for a few minutes; while OpenCode Go doesn't answer,
 * there are none.
 */
import type { AgentModel } from "@t45/contracts/models/Agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { RunnerConfig } from "./RunnerConfig.ts";

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  { readonly models: Effect.Effect<ReadonlyArray<AgentModel>> }
>()("@t45/runner/ModelCatalog") {}

/** Lists OpenCode Go's models, OpenAI-style (`{ data: [{ id }] }`), with the key. */
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
});
const decodeModelList = HttpClientResponse.schemaBodyJson(ModelList);

const make = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const client = yield* HttpClient.HttpClient;

  const list = client
    .execute(
      HttpClientRequest.get(MODELS_URL).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.openCodeKey)),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeModelList),
      Effect.timeout("15 seconds"),
      Effect.map((page) =>
        page.data.map((model) => ({ slug: `opencode-go/${model.id}`, name: model.id })),
      ),
      Effect.tapError((error) => Effect.logWarning("OpenCode Go's model list failed", { error })),
      Effect.orElseSucceed(() => []),
    );

  const models = yield* Effect.cachedWithTTL(list, "5 minutes");
  return ModelCatalog.of({ models });
});

export const layer = Layer.effect(ModelCatalog, make);
