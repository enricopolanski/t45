import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import { runServer } from "./server.ts";

NodeRuntime.runMain(runServer);
