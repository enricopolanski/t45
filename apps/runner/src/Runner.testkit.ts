import { Session } from "@opencode/client/effect";
import { type RunRequest, RunnerRpcs } from "@t45/contracts/resources/Runner";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type { RpcClient, RpcGroup } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Executions from "./Executions.ts";
import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";

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

/** T45's client of the runner, in memory. */
export class Runner extends Context.Service<
  Runner,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof RunnerRpcs>>
>()("@t45/runner/Runner.testkit/Runner") {}

/** Over fake sandboxes; logs are dropped. */
export const layer = Layer.effect(Runner, RpcTest.makeClient(RunnerRpcs)).pipe(
  Layer.provideMerge(Executions.layer),
  Layer.provideMerge(FakeOpenCode.layer),
  Layer.provideMerge(Logger.layer([])),
);
