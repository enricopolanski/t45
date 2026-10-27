import { RpcApi } from "@t45/contracts/resources/RpcApi";
import { AccessDenied } from "@t45/contracts/resources/errors";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import { type Rpc, type RpcGroup, RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";

import { appAtomRegistry } from "../state/atomRegistry";
import { isRpcClientError } from "../lib/failures";

type Rpcs = RpcGroup.Rpcs<typeof RpcApi>;
type Tag = Rpcs["_tag"];
type RpcOf<T extends Tag> = Rpc.ExtractTag<Rpcs, T>;

export type StreamTag = {
  [T in Tag]: [Rpc.IsStream<Rpcs, T>] extends [never] ? never : T;
}[Tag];
export type UnaryTag = Exclude<Tag, StreamTag>;

export type ApiInput<T extends Tag> = Rpc.PayloadConstructor<RpcOf<T>>;
export type ApiSuccess<T extends UnaryTag> = Rpc.Success<RpcOf<T>>;
export type ApiItem<T extends StreamTag> = Rpc.SuccessChunk<RpcOf<T>>;
type ClientFailure<T extends Tag> = Rpc.ErrorExit<RpcOf<T>> | RpcClientError.RpcClientError;
export type ApiFailure<T extends Tag> = ClientFailure<T> | Cause.UnknownError;

type UnaryCalls = {
  readonly [T in UnaryTag]: (input: ApiInput<T>) => Effect.Effect<ApiSuccess<T>, ClientFailure<T>>;
};
type StreamCalls = {
  readonly [T in StreamTag]: (input: ApiInput<T>) => Stream.Stream<ApiItem<T>, ClientFailure<T>>;
};

export class ApiClient extends Context.Service<
  ApiClient,
  { readonly unary: UnaryCalls; readonly streams: StreamCalls }
>()("@t45/web/rpc/api/ApiClient") {}

export const layer = Layer.effect(
  ApiClient,
  Effect.map(RpcClient.make(RpcApi, { disableTracing: true }), (client) =>
    ApiClient.of({ unary: client, streams: client }),
  ),
).pipe(
  Layer.provide(RpcClient.layerProtocolHttp({ url: "/api/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Runs calls and other one-off Effects on the server's RPC client. */
export const runtime = ManagedRuntime.make(
  layer.pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(References.TracerEnabled, false)),
  ),
);

/** The same client for atoms, sharing `runtime`'s one client. */
export const atomRuntime = Atom.runtime(Layer.effectContext(runtime.contextEffect));

export const reachableAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("server-reachable"),
);

let accessDeniedListener: () => void = () => {};

export function onAccessDenied(listener: () => void): void {
  accessDeniedListener = listener;
}

const isAccessDenied = Schema.is(AccessDenied);

const setReachable = (isReachable: boolean) => {
  if (appAtomRegistry.get(reachableAtom) !== isReachable) {
    appAtomRegistry.set(reachableAtom, isReachable);
  }
};

const markReachable = Effect.sync(() => setReachable(true));

const failed = (error: unknown) =>
  Effect.sync(() => {
    setReachable(!isRpcClientError(error));
    if (isAccessDenied(error)) accessDeniedListener();
  });

const serverDefect = (defect: unknown) =>
  new Cause.UnknownError(defect, "Something went wrong on the server.");

export const call = <T extends UnaryTag>(tag: T, input: ApiInput<T>) =>
  ApiClient.use((client) => client.unary[tag](input)).pipe(
    Effect.catchDefect((defect) => Effect.fail(serverDefect(defect))),
    Effect.tap(() => markReachable),
    Effect.tapError((error) => failed(error)),
  );

/** Sends one call on the server's RPC client and rejects with what it failed with. */
export const api = <T extends UnaryTag>(tag: T, input: ApiInput<T>) =>
  runtime.runPromise(call(tag, input));

const restarts = Stream.suspend(() =>
  Stream.merge(
    Stream.fromEventListener(document, "visibilitychange").pipe(
      Stream.filter(() => document.visibilityState === "visible"),
    ),
    Stream.fromEventListener(window, "online"),
  ),
);

const transportBackoff = Schedule.min([
  Schedule.exponential("500 millis").pipe(Schedule.jittered),
  Schedule.spaced("5 minutes"),
]).pipe(Schedule.while(({ input }) => isRpcClientError(input)));

/**
 * Subscribes again when the tab returns to view or the browser comes back online, and with
 * backoff when the transport fails; any other failure ends the stream.
 */
export const watch = <T extends StreamTag>(tag: T, input: ApiInput<T>) =>
  Stream.concat(Stream.make(undefined), restarts).pipe(
    Stream.switchMap(() =>
      Stream.unwrap(ApiClient.useSync((client) => client.streams[tag](input))).pipe(
        Stream.catchDefect((defect) => Stream.fail(serverDefect(defect))),
        Stream.tap(() => markReachable),
        Stream.tapError((error) => failed(error)),
        Stream.retry(transportBackoff),
      ),
    ),
  );
