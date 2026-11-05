import { Session } from "@opencode/client/effect";
import { type Execution, RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import type { RpcClient, RpcGroup } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Executions from "./Executions.ts";
import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";
import { ModelCatalog } from "./ModelCatalog.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

export const ROOT = Session.ID.make("ses_root");

export const execution = (overrides: Partial<Execution> = {}): Execution => ({
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
  conversation: [],
  workspace: null,
  files: {},
  inputs: [],
  ...overrides,
});

const layerModels = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    models: Effect.succeed([{ slug: "opencode-go/glm-5.3", name: "glm-5.3" }]),
  }),
);

export const layerConfig = Layer.succeed(
  RunnerConfig,
  RunnerConfig.of({
    host: "127.0.0.1",
    port: 0,
    token: Redacted.make("secret-token"),
    image: "t45-agent:test",
    ipv4Pool: "10.200.0.0/16",
    denyIps: [],
    openCodeKey: Redacted.make("sk-test"),
  }),
);

/** The runner's handlers over fake VMs; logs are dropped. */
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
