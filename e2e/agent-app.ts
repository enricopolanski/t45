// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Browser fixture owns its processes and clock.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { BuiltIns } from "@t45/contracts/resources/BuiltIns";
import {
  type ExecutionRequest,
  ExecutionUpdate,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { test as base } from "./fixtures.ts";

/** A test with its own app, whose runner the test drives. */
export const test = base.extend<{ agentApp: Awaited<ReturnType<typeof startAgentApp>> }>({
  // Playwright requires destructuring even for fixtures without dependencies.
  // eslint-disable-next-line no-empty-pattern
  agentApp: async ({}, use) => {
    const app = await startAgentApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  baseURL: async ({ agentApp }, use) => use(agentApp.url),
  // This fixture already owns a whole app and database for each test.
  extraHTTPHeaders: {},
});

const decodeBuiltIns = Schema.decodeUnknownSync(Schema.fromJsonString(BuiltIns));
const encodeBuiltIns = Schema.encodeSync(Schema.fromJsonString(BuiltIns));
const decodeUpdate = Schema.decodeUnknownSync(ExecutionUpdate);

interface Execution {
  readonly request: ExecutionRequest;
  /** Sends what the agent's sandbox would, as OpenCode encodes it. */
  readonly emit: (update: typeof ExecutionUpdate.Encoded) => void;
  readonly finish: () => void;
}

/** A real app with an isolated database and a runner controlled by the browser test. */
export async function startAgentApp() {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t45-agent-e2e-"));
  const started = Effect.runSync(Queue.unbounded<Execution>());
  const handlers = RunnerRpcs.toLayer({
    execute: (request) =>
      Stream.callback<ExecutionUpdate>((events) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* Queue.offer(events, {
            _tag: "messages",
            sessionId: request.rootId,
            messages: request.messages.map((message) => ({
              ...message,
              type: "user" as const,
              time: { created: now },
            })),
          });
          yield* Queue.offer(started, {
            request,
            emit: (update) => void Queue.offerUnsafe(events, decodeUpdate(update)),
            finish: () => {
              Queue.offerUnsafe(events, {
                _tag: "finished",
                outcome: null,
                disk: new Uint8Array(),
              });
              Queue.endUnsafe(events);
            },
          });
          return yield* Effect.never;
        }),
      ),
    send: () => Effect.void,
    answer: () => Effect.void,
    dismiss: () => Effect.void,
    cancel: () => Effect.void,
  });
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const rpc = yield* RpcServer.toHttpEffect(RunnerRpcs);
      return HttpRouter.add("POST", "/rpc", rpc);
    }),
  );
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(routes, { disableLogger: true }).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcSerialization.layerNdjsonWith({ maxBufferSize: "unbounded" })),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
      ),
    ),
  );
  const server = await runtime.runPromise(HttpServer.HttpServer);
  if (server.address._tag !== "InetAddressV4") throw new Error("Expected TCP runner");

  const reservation = NodeNet.createServer();
  reservation.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP app");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const url = `http://127.0.0.1:${address.port}`;
  const builtIns = decodeBuiltIns(
    await NodeFSP.readFile(
      NodePath.join(root, "packages/capabilities/dist/built-ins.json"),
      "utf8",
    ),
  );
  const builtInsFile = NodePath.join(directory, "built-ins.json");
  await NodeFSP.writeFile(
    builtInsFile,
    encodeBuiltIns({
      ...builtIns,
      agents: [
        {
          id: "progress-agent",
          name: "Progress agent",
          instructions: "Check the order.",
          model: "opencode-go/test-model",
          files: {},
          skills: [],
          capabilities: ["step-operations", "collections"],
          permissions: { network: "provider" },
          isConversational: true,
        },
      ],
    }),
  );
  const app = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(root, "apps/server/dist/bin.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        BUILD_SHA: undefined,
        DATA_DIR: directory,
        PORT: String(address.port),
        HOST: "127.0.0.1",
        SERVER_URL: url,
        BUILT_INS_FILE: builtInsFile,
        RUNNER_URL: `http://127.0.0.1:${server.address.port}`,
        RUNNER_TOKEN: "test-runner",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const ready = Promise.withResolvers<void>();
  app.on("error", ready.reject);
  app.on("exit", (code) => ready.reject(new Error(`App exited (${code}): ${logs}`)));
  app.stdout.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.includes("T45 server is ready")) ready.resolve();
  });
  app.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  const close = async () => {
    if (app.exitCode === null) {
      const exited = NodeEvents.EventEmitter.once(app, "exit");
      app.kill("SIGTERM");
      await exited;
    }
    await runtime.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  };
  try {
    await ready.promise;
  } catch (error) {
    await close();
    throw error;
  }

  return {
    url,
    close,
    nextExecution: () => runtime.runPromise(Queue.take(started)),
    readReports: (execution: Execution) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "userdata/statev2.sqlite"), {
        readOnly: true,
      });
      try {
        const row = db
          .prepare("SELECT reports FROM chats WHERE id = ?")
          .get(execution.request.rootId.replace("ses_t45_", ""));
        return row?.reports;
      } finally {
        db.close();
      }
    },
    report: (execution: Execution, message: string) =>
      callTool(execution, "report-tools.mjs", "report", { message }),
    callTool,
  };

  /**
   * Calls a tool of the dispatched MCP program, with the token the real runner substitutes at its
   * network boundary.
   */
  async function callTool(
    execution: Execution,
    program: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    const capability = execution.request.agent.capabilities.find((entry) => entry.files?.[program]);
    if (capability === undefined) throw new Error(`${program} was not supplied to the agent`);
    const path = NodePath.join(directory, program);
    await NodeFSP.writeFile(path, capability.files![program]!);
    const tool = NodeChildProcess.spawn(process.execPath, [path], {
      cwd: directory,
      env: {
        ...process.env,
        T45_SERVER_URL: url,
        T45_TOOL_TOKEN: Redacted.value(execution.request.toolToken),
        T45_TOOL_INSTANCE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    tool.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    tool.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const closed = NodeEvents.EventEmitter.once(tool, "close");
    tool.stdin.end(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`,
    );
    const [code] = await closed;
    if (code !== 0) throw new Error(errors);
    return (
      JSON.parse(output) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    ).result;
  }
}
