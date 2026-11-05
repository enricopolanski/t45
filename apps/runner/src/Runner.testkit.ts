import { Session } from "@opencode/client/effect";
import { type RunRequest, RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type { RpcClient, RpcGroup } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Executions from "./Executions.ts";
import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";
import { ModelCatalog } from "./ModelCatalog.ts";

export const ROOT = Session.ID.make("ses_root");

export const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  agent: {
    instructions: "Be brief.",
    model: "opencode-go/test-model",
    mcpServers: {},
    permissions: { network: "provider" },
    files: {},
    skills: [],
  },
  root: ROOT,
  title: "Receipts",
  questions: true,
  disk: null,
  files: {},
  messages: [],
  ...overrides,
});

const layerModels = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    models: Effect.succeed([{ slug: "opencode-go/glm-5.3", name: "glm-5.3" }]),
  }),
);

export const layerConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    T45_RUNNER_TOKEN: "secret-token",
  }),
);

/** The runner's handlers over fake sandboxes; logs are dropped. */
export const layerExecutions = Executions.layer.pipe(
  Layer.provide(layerModels),
  Layer.provideMerge(FakeOpenCode.layer),
  Layer.provideMerge(Logger.layer([])),
);

/** T45's client of the runner, in memory. */
export class Runner extends Context.Service<
  Runner,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof RunnerRpcs>>
>()("@t45/runner/Runner.testkit/Runner") {}

export const layer = Layer.effect(Runner, RpcTest.makeClient(RunnerRpcs)).pipe(
  Layer.provideMerge(layerExecutions),
);
