/*
 * The runner process: its HTTP API and chat proxy over the chat table and microsandbox. On start
 * it clears the VMs an earlier process left, and it lets go of idle ones as it goes.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunnerHttpApi } from "@t45/contracts/resources/RunnerVms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient, HttpRouter } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ChatProxy from "./chatProxy.ts";
import { ChatSandbox } from "./ChatSandbox.ts";
import * as ChatTable from "./ChatTable.ts";
import * as RunnerHttp from "./http.ts";
import * as MicrosandboxChats from "./MicrosandboxChats.ts";
import * as ModelCatalog from "./ModelCatalog.ts";
import * as RunnerConfig from "./RunnerConfig.ts";

const layerRoutes = Layer.merge(
  HttpApiBuilder.layer(RunnerHttpApi).pipe(
    Layer.provide(RunnerHttp.layer),
    Layer.provide(RunnerHttp.layerAuth),
  ),
  ChatProxy.layer,
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RunnerConfig.RunnerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.port,
    });
  }),
);

/** Clears leftover VMs at start, then lets go of idle ones every half minute. */
const layerHousekeeping = Layer.effectDiscard(
  Effect.gen(function* () {
    const sandboxes = yield* ChatSandbox;
    const chats = yield* ChatTable.ChatTable;
    yield* sandboxes.sweep.pipe(
      Effect.catchTags({
        SandboxError: (error) => Effect.logWarning("Clearing old VMs failed", error),
      }),
    );
    yield* chats.stopIdle.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  }),
);

export const layer = Layer.mergeAll(
  HttpRouter.serve(layerRoutes, { routerConfig: RunnerHttp.routerConfig }),
  layerHousekeeping,
).pipe(
  Layer.provideMerge(ChatTable.layer),
  Layer.provideMerge(ModelCatalog.layer),
  Layer.provideMerge(MicrosandboxChats.layer),
  Layer.provideMerge(layerHttpServer),
  Layer.provideMerge(RunnerConfig.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);
