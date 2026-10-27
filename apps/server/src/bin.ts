import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import * as ServerConfig from "./config.ts";
import { runServer } from "./server.ts";

runServer.pipe(
  Effect.provideServiceEffect(ServerConfig.ServerConfig, ServerConfig.fromEnv),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
