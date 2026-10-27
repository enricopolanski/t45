import { RpcApi } from "@t45/contracts/resources/RpcApi";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { Atom } from "effect/reactivity";
import { Rpc, RpcSchema, RpcSerialization } from "effect/rpc";
import { vi } from "@effect/vitest";

import { layer as apiLayer } from "../src/rpc/api";

export interface Exchange {
  readonly tag: string;
  readonly payload: unknown;
  readonly items: (values: ReadonlyArray<unknown>) => void;
  readonly succeed: (value?: unknown) => void;
  readonly fail: (error: unknown) => void;
  readonly die: (defect: unknown) => void;
  readonly drop: () => void;
  readonly closed: Effect.Effect<void>;
}

const RequestMessage = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  tag: Schema.String,
  payload: Schema.Unknown,
});

const decodeRequestMessage = Schema.decodeUnknownSync(RequestMessage);

const exitEncoders = new Map<string, (exit: unknown) => unknown>();
const itemEncoders = new Map<string, (values: unknown) => unknown>();
for (const [tag, rpc] of RpcApi.requests) {
  exitEncoders.set(tag, Schema.encodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(rpc))));
  if (RpcSchema.isStreamSchema(rpc.successSchema)) {
    itemEncoders.set(
      tag,
      Schema.encodeUnknownSync(Schema.toCodecJson(Schema.Array(rpc.successSchema.success))),
    );
  }
}

const encoderOf = <A>(encoders: ReadonlyMap<string, A>, tag: string) => {
  const encoder = encoders.get(tag);
  if (encoder === undefined) throw new Error(`The RpcApi has no ${tag} that answers this way.`);
  return encoder;
};

const readRequest = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array")
    throw new Error("An RPC call posts its message as bytes.");
  const [message] = RpcSerialization.ndjson.makeUnsafe().decode(request.body.body);
  return decodeRequestMessage(message);
};

export const makeFakeApi = Effect.gen(function* () {
  const exchanges = yield* Queue.unbounded<Exchange>();
  const respond = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
    const { id, tag, payload } = readRequest(request);
    const closed = yield* Deferred.make<void>();
    const sink: { controller?: ReadableStreamDefaultController<Uint8Array> } = {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sink.controller = controller;
      },
      cancel: () => {
        Deferred.doneUnsafe(closed, Exit.void);
      },
    });
    const write = (message: unknown) =>
      sink.controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    const exit = (value: Exit.Exit<unknown, unknown>) => {
      write({ _tag: "Exit", requestId: id, exit: encoderOf(exitEncoders, tag)(value) });
      sink.controller?.close();
    };
    yield* Queue.offer(exchanges, {
      tag,
      payload,
      items: (values) =>
        write({ _tag: "Chunk", requestId: id, values: encoderOf(itemEncoders, tag)(values) }),
      succeed: (value) => exit(Exit.succeed(value)),
      fail: (error) => exit(Exit.fail(error)),
      die: (defect) => exit(Exit.die(defect)),
      drop: () => sink.controller?.error(new Error("The connection was reset.")),
      closed: Deferred.await(closed),
    });
    return HttpClientResponse.fromWeb(request, new Response(body));
  });
  const preprocess: HttpClient.HttpClient.Preprocess<never, never> = Effect.succeed;
  const client = HttpClient.makeWith(
    (
      request: Effect.Effect<HttpClientRequest.HttpClientRequest>,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
      Effect.flatMap(request, respond),
    preprocess,
  );
  const layer = apiLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
  return {
    layer,
    atomRuntime: Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(layer),
    next: Queue.take(exchanges),
  };
});

export function installBrowserEvents() {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  return {
    showTab: () => document.dispatchEvent(new Event("visibilitychange")),
  };
}
