// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off
import { Files } from "@cloudflare/sandbox";
import {
  ExecutionFailed,
  RunnerRpcs,
  SCRIPT_INPUT_FILE,
  ScriptOutputs,
  ScriptRequest,
} from "@t45/contracts/resources/Runner";
import { DurableObject, env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

/** The experiment serves only scripted calculations. */
const ScriptRpcs = RunnerRpcs.omit(
  "runScriptForFile",
  "execute",
  "send",
  "answer",
  "dismiss",
  "cancel",
);

/** Calculation payloads are small; the Worker and the Durable Object each hold them in an isolate. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const WORK = "/work";
/** The local calculation VM's CPU and memory. */
const INSTANCE = { vcpu: 1, memoryMib: 512, diskMb: 4000 };

/** A calculation script with its encoded inputs and files, as the Worker hands it to the sandbox. */
type Script = { entrypoint: string; input: string; files: Record<string, string> };
type ScriptResult = { stdout: string } | { reason: string };

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

const toIsoTime = (time: number) => new Date(time).toISOString();

class ScriptFailure extends Error {}

const readStdout = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STDOUT_BYTES) {
      await reader.cancel();
      throw new ScriptFailure("The calculation printed more than 1 MiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** One container per calculation; the method destroys it before returning. */
export class Calculation extends DurableObject<Env> {
  async run(script: Script): Promise<ScriptResult> {
    const container = this.ctx.container;
    if (container === undefined) return { reason: "The container binding is missing." };
    const sandboxId = this.ctx.id.toString();
    const startedAt = Date.now();
    let preparedAt: number | undefined;
    let finishedAt: number | undefined;
    let result: ScriptResult;
    // Cleared on return: a pending timer would keep the invocation open and later signal a destroyed container.
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    log("sandbox.start", { sandboxId, startedAt: toIsoTime(startedAt) });
    try {
      try {
        container.start({
          image: container.images["calculation"]!,
          enableInternet: false,
          instance: INSTANCE,
        });
        const files = new Files(container);
        const paths = [SCRIPT_INPUT_FILE, ...Object.keys(script.files)].map(
          (path) => `${WORK}/${path}`,
        );
        for (const folder of new Set(paths.map((path) => path.slice(0, path.lastIndexOf("/")))))
          if (folder !== WORK) await files.mkdir(folder, { recursive: true });
        await files.writeFile(`${WORK}/${SCRIPT_INPUT_FILE}`, script.input);
        for (const [path, content] of Object.entries(script.files))
          await files.writeFile(`${WORK}/${path}`, content);
      } catch (error) {
        throw new ScriptFailure(
          container.running
            ? `The sandbox could not stage the calculation files: ${String(error)}`
            : `The sandbox did not start: ${String(error)}`,
        );
      }
      preparedAt = Date.now();
      const expired = new Promise<never>((_resolve, reject) =>
        deadline.signal.addEventListener(
          "abort",
          () => reject(new ScriptFailure("The calculation did not finish within 30 seconds.")),
          { once: true },
        ),
      );
      timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
      const process = await Promise.race([
        container.exec(["node", `${WORK}/${script.entrypoint}`, `${WORK}/${SCRIPT_INPUT_FILE}`], {
          cwd: WORK,
          user: "agent",
          signal: deadline.signal,
          stdout: "pipe",
          stderr: "ignore",
        }),
        expired,
      ]);
      const [stdout, exitCode] = await Promise.race([
        Promise.all([readStdout(process.stdout!), process.exitCode]),
        expired,
      ]);
      finishedAt = Date.now();
      result =
        exitCode === 0 ? { stdout } : { reason: `The calculation exited with code ${exitCode}.` };
    } catch (error) {
      finishedAt ??= Date.now();
      result = {
        reason:
          error instanceof ScriptFailure ? error.message : `The sandbox failed: ${String(error)}`,
      };
    } finally {
      clearTimeout(timer);
      let isDestroyed = true;
      try {
        await container.destroy();
      } catch (error) {
        isDestroyed = false;
        log("sandbox.destroy_failed", { sandboxId, error: String(error) });
      }
      const stoppedAt = Date.now();
      log("sandbox.stop", {
        sandboxId,
        isDestroyed,
        instance: INSTANCE,
        startedAt: toIsoTime(startedAt),
        stoppedAt: toIsoTime(stoppedAt),
        prepareMs: preparedAt === undefined ? null : preparedAt - startedAt,
        commandMs: preparedAt === undefined ? null : finishedAt! - preparedAt,
        outcome: "reason" in result! ? result.reason : "succeeded",
      });
    }
    return result;
  }
}

const encodeInputs = Schema.encodeSync(Schema.fromJsonString(ScriptRequest.fields.inputs));
const decodeOutputs = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptOutputs));

const handlers = ScriptRpcs.toLayer({
  runScript: Effect.fnUntraced(function* (request) {
    if (
      !Object.hasOwn(request.files, request.entrypoint) ||
      !/\.(?:js|mjs|ts)$/u.test(request.entrypoint)
    )
      return yield* new ExecutionFailed({
        reason: "Choose a JavaScript or TypeScript file from the calculation files.",
      });
    const sandbox = env.CALCULATION.get(env.CALCULATION.newUniqueId());
    const result = yield* Effect.tryPromise({
      // Annotated: the binding's type refers back to this module, which leaves it unresolved here.
      try: (): Promise<ScriptResult> =>
        sandbox.run({
          entrypoint: request.entrypoint,
          input: encodeInputs(request.inputs),
          files: { ...request.files },
        }),
      catch: (error) => new ExecutionFailed({ reason: `The sandbox failed: ${String(error)}` }),
    });
    if ("reason" in result) return yield* new ExecutionFailed({ reason: result.reason });
    return yield* decodeOutputs(result.stdout).pipe(
      Effect.mapError(
        () =>
          new ExecutionFailed({
            reason: "The calculation must print its outputs as a JSON object.",
          }),
      ),
    );
  }),
});

/** Only T45 calls the runner, with its bearer token; the body is read after the check. */
const routes = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcServer.toHttpEffect(ScriptRpcs, {
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
    Layer.provide(RpcSerialization.layerSchemaBinary()),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))),
  ),
  { disableLogger: true },
);

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler<Env>;
