import {
  AnswerInvalid,
  ExecutionFailed,
  QuestionGone,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { makeScripts, ScriptSandbox } from "../src/Scripts.ts";
import type { ScriptResult } from "./calculation.ts";
import { decodeLine, ExecutionRequestJson } from "./execution.ts";

export { Calculation } from "./calculation.ts";
export { Execution, Outbound } from "./execution.ts";

/** Room for a message's attachments, each up to the attachment limit. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const encodeRequest = Schema.encodeSync(ExecutionRequestJson);

/** Each script in a new container; the binding's type refers back to this module, so it is annotated. */
const calculationSandbox = Layer.succeed(ScriptSandbox, {
  run: (script) =>
    Effect.tryPromise({
      try: (): Promise<ScriptResult> =>
        env.CALCULATION.get(env.CALCULATION.newUniqueId()).run(script),
      catch: (error) => new ExecutionFailed({ reason: `The sandbox failed: ${String(error)}` }),
    }).pipe(
      Effect.flatMap((result) =>
        "reason" in result
          ? Effect.fail(new ExecutionFailed({ reason: result.reason }))
          : Effect.succeed(result),
      ),
    ),
});

const executionOf = (rootId: string) => env.EXECUTION.getByName(rootId);

/** An execution's updates, one JSON line each, ending at the failure line if it failed. */
const updatesOf = (body: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => body,
    onError: (error) => new ExecutionFailed({ reason: `The sandbox stopped: ${String(error)}` }),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapEffect((line) =>
      decodeLine(line).pipe(
        Effect.orDie,
        Effect.flatMap((update) =>
          update._tag === "ExecutionFailed" ? Effect.fail(update) : Effect.succeed(update),
        ),
      ),
    ),
  );

const handlers = RunnerRpcs.toLayer(
  Effect.map(makeScripts, (scripts) =>
    RunnerRpcs.of({
      ...scripts,
      execute: (request) =>
        Stream.unwrap(
          Effect.tryPromise({
            try: (): Promise<ReadableStream<Uint8Array>> =>
              executionOf(request.rootId).execute(encodeRequest(request)),
            catch: (error) =>
              new ExecutionFailed({ reason: `The sandbox failed: ${String(error)}` }),
          }).pipe(Effect.map(updatesOf)),
        ),
      send: (payload) => Effect.promise(() => executionOf(payload.rootId).send(payload)),
      cancel: (payload) => Effect.promise(() => executionOf(payload.rootId).cancel(payload)),
      answer: (payload) =>
        Effect.promise(() => executionOf(payload.rootId).answer(payload)).pipe(
          Effect.flatMap((refusal) =>
            refusal === null
              ? Effect.void
              : Effect.fail(refusal === "AnswerInvalid" ? new AnswerInvalid() : new QuestionGone()),
          ),
        ),
      dismiss: (payload) =>
        Effect.promise(() => executionOf(payload.rootId).dismiss(payload)).pipe(
          Effect.flatMap((refusal) =>
            refusal === null ? Effect.void : Effect.fail(new QuestionGone()),
          ),
        ),
      respond: ({ rootId, ...response }) =>
        Effect.promise(() => executionOf(rootId).respond(response)),
    }),
  ),
).pipe(Layer.provide(calculationSandbox));

/** Only T45 calls the runner, with its bearer token; the body is read after the check. */
const routes = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcServer.toHttpEffect(RunnerRpcs, {
      disableTracing: true,
      disableFatalDefects: true,
    });
    return HttpRouter.add(
      "POST",
      "/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          !env.T45_RUNNER_TOKEN ||
          request.headers.authorization !== `Bearer ${env.T45_RUNNER_TOKEN}`
        )
          return HttpServerResponse.empty({ status: 401 });
        if (!(Number(request.headers["content-length"]) <= MAX_BODY_BYTES))
          return HttpServerResponse.empty({ status: 413 });
        return yield* rpc;
      }),
    );
  }),
);

// Built at module scope with the sync scheduler, as Effect advises for Workers.
const app = HttpRouter.toWebHandler(
  routes.pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: MAX_BODY_BYTES })),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))),
  ),
  { disableLogger: true },
);

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler<Env>;
