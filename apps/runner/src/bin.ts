/** Starts the runner. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RunnerServer from "./server.ts";

NodeRuntime.runMain(Layer.launch(RunnerServer.layer).pipe(Effect.withTracerEnabled(false)));
