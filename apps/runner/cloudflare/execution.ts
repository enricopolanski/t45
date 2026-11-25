// @effect-diagnostics globalConsole:off globalDate:off globalDateInEffect:off globalTimers:off globalFetch:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off
import { Files } from "@cloudflare/sandbox";
import {
  ExecutionFailed,
  ExecutionRequest,
  ExecutionUpdate,
  type RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import {
  type AgentSetup,
  agentSetupFiles,
  KEY_ENV,
  PROVIDER_HOST,
  secretPlaceholder,
  TOOL_TOKEN_ENV,
  TOOL_TOKEN_PLACEHOLDER,
} from "../src/AgentSetup.ts";
import {
  makeExecutions,
  type Sandbox,
  SandboxError,
  Sandboxes,
} from "../src/ExecutionOrchestrator.ts";
import { log, toIsoTime, writeFiles } from "./container.ts";

type RunnerRpc = RpcGroup.Rpcs<typeof RunnerRpcs>;
type Payload<Tag extends RunnerRpc["_tag"]> = Rpc.Payload<Rpc.ExtractTag<RunnerRpc, Tag>>;

const OPENCODE_PORT = 4096;
/** Where the agent's tools reach T45: the outbound handler relays this origin to the server. */
const SERVER_ORIGIN = "http://t45.internal";
/** Cloudflare re-signs intercepted HTTPS with this authority. */
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** The local agent VM's CPU and memory. */
const INSTANCE = { vcpu: 2, memoryMib: 2048, diskMb: 8000 };
/** How long a relayed request waits for the server's answer. */
const RELAY_TIMEOUT_MS = 10 * 60 * 1000;
/** Set by the connection itself, not forwarded with a relayed request. */
const CONNECTION_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);

/** What leaves an agent's container, and which credentials go to which host. */
type OutboundPolicy = {
  readonly rootId: string;
  readonly isOpen: boolean;
  /** The hosts the agent's capabilities reach besides the provider. */
  readonly hosts: ReadonlyArray<string>;
  /** Each capability secret with the hosts it goes to. */
  readonly secrets: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
};

type ServerRequest = Omit<
  Extract<ExecutionUpdate, { _tag: "serverRequest" }>,
  "_tag" | "requestId"
>;
type ServerResponse = Omit<Payload<"respond">, "rootId" | "requestId">;

/** The running execution's way back to the server, and the relayed requests awaiting its answer. */
type ServerConnection = {
  readonly emit: (event: ExecutionUpdate) => Effect.Effect<void>;
  readonly toolToken: string;
  readonly pending: Map<string, (response: ServerResponse) => void>;
};

const emptyResponse = (status: number) => ({ status, headers: {}, body: new Uint8Array() });

/**
 * Every HTTP request and every intercepted HTTPS request an agent's container sends. Credentials
 * stay here: the container holds placeholders, swapped for the real values only on the way to the
 * hosts they belong to. Requests to T45 travel back to the server over the execution's stream.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundPolicy> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const policy = this.ctx.props;
    if (url.origin === SERVER_ORIGIN) return this.#relay(request, url);
    const isProvider = url.hostname === PROVIDER_HOST;
    if (!policy.isOpen && !isProvider && !policy.hosts.includes(url.hostname))
      return new Response(`This agent can't reach ${url.hostname}.\n`, { status: 403 });
    const swaps = [
      ...(isProvider ? [[secretPlaceholder(KEY_ENV), this.env.OPENCODE_API_KEY] as const] : []),
      ...policy.secrets
        .filter(([, hosts]) => hosts.includes(url.hostname))
        .map(
          ([name]) =>
            [secretPlaceholder(name), Reflect.get(this.env, `CAPABILITY_SECRET_${name}`)] as const,
        ),
    ];
    if (swaps.length === 0) return fetch(request);
    // Fetched with the container's scheme: a credential must not cross the internet in the clear.
    if (url.protocol !== "https:")
      return new Response("Credentials are only sent over HTTPS.\n", { status: 403 });
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      let swapped = value;
      for (const [placeholder, secret] of swaps)
        if (typeof secret === "string") swapped = swapped.replaceAll(placeholder, secret);
      headers.set(name, swapped);
    }
    return fetch(new Request(request, { headers }));
  }

  async #relay(request: Request, url: URL) {
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers)
      if (!CONNECTION_HEADERS.has(name)) headers[name] = value;
    const answer = await this.env.EXECUTION.getByName(this.ctx.props.rootId).relay({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      body: new Uint8Array(await request.arrayBuffer()),
    });
    const hasBody = answer.status !== 204 && answer.status !== 304 && request.method !== "HEAD";
    return new Response(hasBody ? answer.body : null, {
      status: answer.status,
      headers: answer.headers,
    });
  }
}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SandboxError({ operation, cause }) });

/** Crosses into the Durable Object as JSON, which a binding call can always carry. */
export const ExecutionRequestJson = Schema.fromJsonString(Schema.toCodecJson(ExecutionRequest));
const decodeRequest = Schema.decodeSync(ExecutionRequestJson);
/** One line per update, and the failure that ends an execution as its last line. */
const ExecutionLine = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Union([ExecutionUpdate, ExecutionFailed])),
);
const encodeLine = Schema.encodeSync(ExecutionLine);
export const decodeLine = Schema.decodeUnknownEffect(ExecutionLine);

/**
 * One chat's container and its OpenCode, by the chat's root session id. The container lives for
 * one execution: the runner keeps no disk, so a chat can't continue in a later execution.
 */
export class Execution extends DurableObject<Env> {
  readonly #container: Container;
  readonly #executions;
  #server: ServerConnection | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#container = ctx.container!;
    this.#executions = Effect.runSync(
      Effect.provideService(makeExecutions, Sandboxes, {
        start: (request, agent, emit) => this.#start(request, agent, emit),
      }),
    );
  }

  #start(
    request: ExecutionRequest,
    agent: AgentSetup,
    emit: (event: ExecutionUpdate) => Effect.Effect<void>,
  ) {
    const container = this.#container;
    const ctx = this.ctx;
    const sandboxId = ctx.id.toString();
    const isOpen = agent.permissions.network === "open";
    const policy: OutboundPolicy = {
      rootId: request.rootId,
      isOpen,
      hosts: agent.hosts,
      secrets: [...agent.secrets],
    };
    const setServer = (server: ServerConnection | undefined) => {
      this.#server = server;
    };
    return Effect.gen(function* () {
      // A chat that ran before has a disk, empty when it ran here: its conversation is gone.
      if (request.disk !== null)
        return yield* new ExecutionFailed({
          reason:
            "This chat can't continue on the Cloudflare runner, which starts every execution in a new sandbox.",
        });
      const startedAt = Date.now();
      yield* Effect.acquireRelease(
        attempt("start", async () => {
          container.start({
            image: container.images["agent"]!,
            enableInternet: isOpen,
            instance: INSTANCE,
          });
          const outbound = ctx.exports.Outbound({ props: policy });
          await container.interceptAllOutboundHttp(outbound);
          // An open network goes out directly except where a credential must be added.
          const intercepted = isOpen
            ? [PROVIDER_HOST, ...new Set(policy.secrets.flatMap(([, hosts]) => hosts))]
            : ["*"];
          for (const host of intercepted) await container.interceptOutboundHttps(host, outbound);
          log("sandbox.start", { sandboxId, kind: "execution", startedAt: toIsoTime(startedAt) });
        }),
        () =>
          Effect.promise(async () => {
            setServer(undefined);
            let isDestroyed = true;
            try {
              await container.destroy();
            } catch (error) {
              isDestroyed = false;
              log("sandbox.destroy_failed", { sandboxId, error: String(error) });
            }
            log("sandbox.stop", {
              sandboxId,
              kind: "execution",
              isDestroyed,
              instance: INSTANCE,
              startedAt: toIsoTime(startedAt),
              stoppedAt: toIsoTime(Date.now()),
            });
          }),
      );
      setServer({ emit, toolToken: Redacted.value(request.toolToken), pending: new Map() });
      // Node reads the authority from NODE_EXTRA_CA_CERTS; other programs from the system store.
      yield* attempt("trust", async () => {
        const process = await container.exec(
          [
            "sh",
            "-c",
            `[ ! -f ${CA_PATH} ] || { cp ${CA_PATH} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates; }`,
          ],
          { user: "root", stdout: "ignore", stderr: "ignore" },
        );
        const exitCode = await process.exitCode;
        if (exitCode !== 0) throw new Error(`It exited with ${exitCode}.`);
      });
      const files = new Files(container);
      yield* attempt("setup", () => writeFiles(files, agentSetupFiles(agent)));
      const password = crypto.randomUUID();
      yield* attempt("serve", () =>
        container.exec(
          [
            "sh",
            "-c",
            `cd /work && exec opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT} >/tmp/opencode-serve.log 2>&1`,
          ],
          {
            env: {
              PATH,
              HOME: "/home/agent",
              NO_UPDATE_NOTIFIER: "1",
              NODE_EXTRA_CA_CERTS: CA_PATH,
              OPENCODE_PASSWORD: password,
              [KEY_ENV]: secretPlaceholder(KEY_ENV),
              [TOOL_TOKEN_ENV]: TOOL_TOKEN_PLACEHOLDER,
              ...Object.fromEntries(
                [...agent.secrets.keys()].map((name) => [name, secretPlaceholder(name)]),
              ),
              ...agent.environment,
            },
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
      return {
        url: "http://opencode",
        password: Redacted.make(password),
        write: (path: string, content: Uint8Array) =>
          attempt("write", () => writeFiles(files, [[`/work/${path}`, content]])),
        save: Effect.succeed(new Uint8Array()),
      } satisfies Sandbox;
    });
  }

  /** The execution's updates, one JSON line each; cancelling the stream stops the execution. */
  execute(encoded: string): ReadableStream<Uint8Array> {
    const request = decodeRequest(encoded);
    const relocated = {
      ...request,
      serverUrl: SERVER_ORIGIN,
      context: { ...request.context, serverUrl: SERVER_ORIGIN },
    };
    const encoder = new TextEncoder();
    const lines = this.#executions.execute(relocated).pipe(
      Stream.map((update) => encodeLine(update)),
      Stream.catch((failure) => Stream.make(encodeLine(failure))),
      Stream.map((line) => encoder.encode(`${line}\n`)),
      Stream.provide(FetchHttpClient.layer),
      Stream.provideService(FetchHttpClient.Fetch, ((
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => this.#container.getTcpPort(OPENCODE_PORT).fetch(input, init)) as typeof fetch),
    );
    return Stream.toReadableStream(lines);
  }

  async send(payload: Payload<"send">) {
    await Effect.runPromise(this.#executions.send(payload));
  }

  async cancel(payload: Payload<"cancel">) {
    await Effect.runPromise(this.#executions.cancel(payload));
  }

  /** The refusal's tag, or null when the answer went through. */
  async answer(payload: Payload<"answer">) {
    return refusalOf(await Effect.runPromiseExit(this.#executions.answer(payload)));
  }

  async dismiss(payload: Payload<"dismiss">) {
    return refusalOf(await Effect.runPromiseExit(this.#executions.dismiss(payload)));
  }

  /** Sends the agent's request to the server over the execution's stream and waits for its answer. */
  async relay(request: ServerRequest): Promise<ServerResponse> {
    const server = this.#server;
    if (server === undefined) return emptyResponse(503);
    const requestId = crypto.randomUUID();
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        value.replaceAll(TOOL_TOKEN_PLACEHOLDER, server.toolToken),
      ]),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<ServerResponse>((resolve) => {
      server.pending.set(requestId, resolve);
      timer = setTimeout(() => resolve(emptyResponse(504)), RELAY_TIMEOUT_MS);
    });
    await Effect.runPromise(server.emit({ _tag: "serverRequest", requestId, ...request, headers }));
    try {
      return await answered;
    } finally {
      clearTimeout(timer);
      server.pending.delete(requestId);
    }
  }

  respond({ requestId, ...response }: Omit<Payload<"respond">, "rootId">) {
    this.#server?.pending.get(requestId)?.(response);
  }
}

const refusalOf = (exit: Exit.Exit<void, { readonly _tag: string }>) => {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "None") throw Cause.squash(exit.cause);
  return failure.value._tag;
};
