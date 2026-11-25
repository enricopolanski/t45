import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
} from "effect/http";

import * as BuiltIns from "../src/BuiltIns.ts";
import { ChatRepository } from "../src/chats/ChatRepository.ts";
import { Restarts } from "../src/chats/Restarts.ts";
import * as ServerConfig from "../src/config.ts";
import * as Instance from "../src/Instance.ts";
import { OwnApi } from "../src/runner/OwnApi.ts";
import * as Files from "./Files.ts";
import * as Sqlite from "./Sqlite.ts";

/** Names the object of a development instance, chosen by `x-instance-id` as on Node. */
export const DEV_INSTANCE_PREFIX = "instance:";

/**
 * Local development only, set with `--var T45_DEVELOPMENT:true`: anyone signs in with a typed email
 * and `x-instance-id` picks an instance. Without it, the Worker needs a release's BUILD_SHA.
 */
export const isDevelopment = (env: Env) => Reflect.get(env, "T45_DEVELOPMENT") === "true";

type Handler = (request: Request, context?: Context.Context<never>) => Promise<Response>;

/** The browser's WebSocket, accepted by the object, for the RPC route's upgrade to take over. */
class AcceptedSocket extends Context.Service<AcceptedSocket, WebSocket>()(
  "t45/cloudflare/instance/AcceptedSocket",
) {}

/** A request that brings an accepted socket upgrades to it: workerd's requests can't upgrade. */
const upgrade = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const accepted = yield* Effect.serviceOption(AcceptedSocket);
      if (accepted._tag === "None") return yield* httpEffect;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const upgraded: HttpServerRequest.HttpServerRequest = Object.create(request, {
        upgrade: { value: Socket.fromWebSocket(Effect.succeed(accepted.value)) },
      });
      return yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, upgraded),
      );
    }),
  { global: true },
);

/** The deployment's built-ins, uploaded beside each release; an instance applies each version once. */
const BUILT_INS_KEY = "built-ins.json";
/** The version of the built-ins the instance last applied: the object's etag. */
const APPLIED_BUILT_INS = "appliedBuiltIns";

/** Reads the built-ins when their version is new to the instance, and remembers which it read. */
const builtInsSource = (state: DurableObjectState, env: Env, read: { etag?: string }) =>
  Layer.succeed(BuiltIns.Source, {
    read: Effect.promise(async () => {
      const object = await env.BUILT_INS.get(BUILT_INS_KEY);
      if (object === null || object.etag === state.storage.kv.get(APPLIED_BUILT_INS))
        return Option.none();
      read.etag = object.etag;
      return Option.some(await object.text());
    }),
  });

/** Relayed agent requests go straight to the instance's own handler: a Worker has no loopback. */
const ownApi = (own: { handler?: Handler }) =>
  Layer.effect(
    OwnApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // The fetch client reads its fetch from the calling fiber, so each request brings this one.
      const fetch: typeof globalThis.fetch = (input, init) =>
        own.handler!(new Request(input, init));
      return client.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("http://instance")),
        HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * How often the object wakes while a chat runs. Cloudflare evicts an object after 70 to 140 s with
 * no incoming request or event, and a run's stream to the runner goes with it; a 20-minute run held
 * with this interval. After a restart it brings the object back.
 */
const WAKE_INTERVAL_MS = 30_000;

const armAlarm = (state: DurableObjectState) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() => state.storage.setAlarm(now + WAKE_INTERVAL_MS));
    yield* Effect.logDebug("Armed the wake alarm", { inMs: WAKE_INTERVAL_MS });
  });

/**
 * The object starts again on its alarm. A run it held can't continue: the Cloudflare runner keeps no
 * disk, and running it again from its first message could repeat what its tools did.
 */
const restarts = (state: DurableObjectState) =>
  Layer.succeed(Restarts, {
    whileRunning: Effect.promise(() => state.storage.getAlarm()).pipe(
      Effect.flatMap((alarm) => (alarm === null ? armAlarm(state) : Effect.void)),
    ),
    continuesRunning: false,
  });

const configOf = (env: Env, name: string) =>
  ConfigProvider.fromUnknown({
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
    // Names the instance's session cookie, as a data directory does on Node.
    DATA_DIR: `/t45/${name}`,
    TOOL_INSTANCE: name.startsWith(DEV_INSTANCE_PREFIX)
      ? name.slice(DEV_INSTANCE_PREFIX.length)
      : "",
  });

const LogLevel = Layer.unwrap(
  Effect.map(ServerConfig.logLevel, (level) => Layer.succeed(References.MinimumLogLevel, level)),
);

/** Builds the instance for as long as the object lives, and answers its API requests. */
const start = (state: DurableObjectState, env: Env, own: { handler?: Handler }) =>
  Effect.gen(function* () {
    if (!("BUILD_SHA" in env) && !isDevelopment(env))
      return yield* Effect.die(
        new Error("Set BUILD_SHA for a release, or T45_DEVELOPMENT=true locally."),
      );
    const scope = yield* Scope.make();
    const builtIns: { etag?: string } = {};
    const name = state.id.name ?? env.T45_INSTANCE;
    const services = yield* Layer.buildWithScope(
      Instance.Dependencies.pipe(
        Layer.provideMerge(Sqlite.layer(state.storage)),
        Layer.provide(
          Layer.mergeAll(
            builtInsSource(state, env, builtIns),
            Files.chatDisks(env.FILES, name),
            Files.blobs(env.FILES, name),
            ownApi(own),
            restarts(state),
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer, Path.layer)),
        Layer.provideMerge(Layer.merge(Logger.layer([Logger.consoleJson]), LogLevel)),
        Layer.provide(ConfigProvider.layer(configOf(env, name))),
      ),
      scope,
    );
    const app = yield* HttpRouter.toHttpEffect(Layer.merge(Instance.ApiRoutes, upgrade)).pipe(
      Effect.map(Effect.provideContext(services)),
      Effect.provideContext(services),
      Scope.provide(scope),
    );
    // Applied only once the instance started with them.
    if (builtIns.etag !== undefined) state.storage.kv.put(APPLIED_BUILT_INS, builtIns.etag);
    own.handler = HttpEffect.toWebHandlerWith<
      never,
      Scope.Scope | HttpServerRequest.HttpServerRequest
    >(Context.empty())(app);
    return services;
  }).pipe(Effect.tapCause((cause) => Effect.logError("The instance failed to start", cause)));

/** One T45 instance: its database, live watches and background work, behind its API. */
export class InstanceObject extends DurableObject<Env> {
  private readonly own: { handler?: Handler } = {};
  private services: Context.Context<ChatRepository> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    void state.blockConcurrencyWhile(async () => {
      this.services = await Effect.runPromise(start(state, env, this.own));
    });
  }

  override async fetch(request: Request) {
    const handler = this.own.handler!;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return handler(request);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    // The socket outlives the upgrade request, so the RPC runs on a request of its own.
    void handler(
      new Request(request.url, { headers: request.headers }),
      Context.make(AcceptedSocket, server),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Waking up started the instance, which settled the runs it held; wakes again while one runs. */
  override async alarm() {
    const state = this.ctx;
    await Effect.runPromise(
      Effect.gen(function* () {
        const running = yield* (yield* ChatRepository).owed;
        yield* Effect.logDebug("Woke on the alarm", { running: running.length });
        if (running.length > 0) yield* armAlarm(state);
      }).pipe(Effect.provideContext(this.services!)),
    );
  }
}
