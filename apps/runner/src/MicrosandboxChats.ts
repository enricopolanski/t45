/*
 * VMs on microsandbox: one named microVM per chat, from the agent image, as its non-root `agent`
 * user under the restricted profile, with the agent's sandbox network and the runner's OpenCode Go
 * key as a secret. Inputs go in as bytes over the control channel; nothing of the host is mounted.
 * Its OpenCode server listens on a port published to the host's loopback, behind a password made
 * fresh at every start. The runner starts VMs attached, so they stop with it. A VM keeps nothing:
 * every start makes a new one from its config, and letting it go removes it.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { OpenCode } from "@opencode/client/effect";
import { Config } from "@opencode/schema/config";
import type { RunConfig } from "@t45/contracts/resources/RunnerVms";
import * as Bytes from "effect/Bytes";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  type ExecHandle,
  type NetworkBuilder,
  NetworkPolicy,
  Sandbox,
  type SandboxHandle,
  SandboxNotFoundError,
} from "microsandbox";

import { ChatSandbox, type ChatServer, SandboxError } from "./ChatSandbox.ts";
import { RunnerConfig } from "./RunnerConfig.ts";
import type { SkillSnapshot } from "@t45/contracts/resources/RunnerVms";

/** Where OpenCode listens inside the VM. */
const GUEST_PORT = 4096;

/** What a chat's VM gets: its CPUs and memory, and room for the chat's files. */
const CHAT_LIMITS = { cpus: 2, memoryMib: 2048, diskMib: 4096 };

/** Sandboxes this runner made, so a restart can find them. */
const LABEL = "t45-runner";
/**
 * The port of the runner that made a sandbox. Several runners can share a machine, as dev
 * checkouts do, and no two listen on one port, so each sweeps only what it left behind.
 */
const RUNNER_PORT_LABEL = "t45-runner-port";

/** The labels marking a sandbox as this runner's. */
const runnerLabels = (config: RunnerConfig["Service"]) => ({
  [LABEL]: "chat",
  [RUNNER_PORT_LABEL]: String(config.port),
});

/** The SDK types its network setter loosely; this is what it hands the callback. */
type NetworkSettings = InstanceType<typeof NetworkBuilder>;

const sdk = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SandboxError({ operation, cause }) });

/** OpenCode Go's API: the one host a provider-only network reaches, and the one the key goes to. */
const PROVIDER_HOST = "opencode.ai";
/** The variable OpenCode reads the key from; inside the VM it holds a placeholder. */
const KEY_ENV = "OPENCODE_API_KEY";

/**
 * The network a VM gets: outbound denied but for OpenCode Go's API on 443, or the public internet
 * less the runner's own addresses (and DNS through the host, which the provider-only network does
 * without), with TLS interception on and the key as a secret bound to OpenCode Go's host. The host
 * reaches OpenCode on `hostPort`, which binds to its loopback, so only the host can.
 */
const sandboxNetwork =
  (
    config: RunnerConfig["Service"],
    network: RunConfig["agent"]["permissions"]["network"],
    hostPort: number,
  ) =>
  (settings: NetworkSettings) => {
    let policy = NetworkPolicy.builder().defaultEgress("deny").defaultIngress("allow");
    if (network === "provider") {
      policy = policy.egress((rule) => rule.tcp().port(443).allowDomain(PROVIDER_HOST));
    } else {
      for (const ip of config.denyIps) {
        policy = policy.egress((rule) => rule.deny((to) => to.ip(ip)));
      }
      // Names resolve through the host; with the internet open, their queries leak nothing more.
      policy = policy.egress((rule) => rule.udp().tcp().port(53).allowHost());
      policy = policy.egress((rule) => rule.allowPublic());
    }
    return settings
      .policyFromBuilder(policy)
      .ipv4Pool(config.ipv4Pool)
      .tls((tls) => tls)
      .secret((secret) =>
        secret
          .env(KEY_ENV)
          .value(Redacted.value(config.openCodeKey))
          .allow(PROVIDER_HOST)
          .substituteInHeaderFields(["authorization"]),
      )
      .portBind("127.0.0.1", hostPort, GUEST_PORT);
  };

/** A SKILL.md with the frontmatter OpenCode reads. */
const skillMarkdown = (skill: SkillSnapshot) =>
  `---\nname: ${skill.name}\ndescription: ${skill.description.replaceAll("\n", " ")}\n---\n\n${skill.content}`;

/** opencode.json as OpenCode reads it. */
type OpenCodeConfig = typeof Config.Info.Encoded;

/** Checked against OpenCode's schema as it is written, so a VM never boots on one it refuses. */
const encodeOpenCodeConfig = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toEncoded(Config.Info)),
);

/** The VM's MCP servers, with fetching only on an open network. */
const openCodeConfig = (chat: RunConfig): OpenCodeConfig => {
  const fetching = chat.agent.permissions.network === "provider" ? "deny" : "allow";
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "webfetch", resource: "*", effect: fetching },
      { action: "websearch", resource: "*", effect: fetching },
    ],
    mcp: { servers: chat.agent.mcpServers },
  };
};

/** Writes a file into /work as root, making its folders. */
const writeInto = (
  sandbox: Sandbox,
  relative: string,
  content: string | Uint8Array,
): Effect.Effect<void, SandboxError> => {
  const target = `/work/${relative}`;
  const fs = sandbox.fs();
  return sdk("mkdir", () => fs.mkdir(target.slice(0, target.lastIndexOf("/")))).pipe(
    Effect.andThen(sdk("write", () => fs.write(target, content))),
  );
};

/**
 * What a chat's saved workspace leaves out of /work: what every start writes (attachments, AGENTS.md,
 * opencode.json, skills), the step tools' snapshots, and caches anywhere that rebuild.
 */
const WORKSPACE_EXCLUDES = [
  "--anchored",
  "--exclude=./attachments",
  "--exclude=./AGENTS.md",
  "--exclude=./opencode.json",
  "--exclude=./.opencode/skills",
  "--exclude=./.t45",
  "--no-anchored",
  "--exclude=node_modules",
  "--exclude=.venv",
  "--exclude=__pycache__",
  "--exclude=.cache",
];

/** Told to every chat's agent, after its own instructions: what survives its VM. */
const WORKSPACE_INSTRUCTIONS = `Only /work survives when this chat's sandbox stops, without attachments/ and caches such as node_modules, .venv, __pycache__ and .cache.`;

/**
 * Writes the agent's setup into /work: AGENTS.md from its instructions and what survives the VM,
 * its own files, its skills, and opencode.json.
 */
const writeAgentSetup = Effect.fn("MicrosandboxChats.writeAgentSetup")(function* (
  sandbox: Sandbox,
  chat: RunConfig,
) {
  const instructions = [chat.agent.instructions, WORKSPACE_INSTRUCTIONS]
    .filter((text) => text.trim() !== "")
    .join("\n\n");
  yield* writeInto(sandbox, "AGENTS.md", instructions);
  for (const [path, content] of Object.entries(chat.agent.files)) {
    yield* writeInto(sandbox, path, content);
  }
  for (const [name, skill] of Object.entries(chat.agent.skills)) {
    yield* writeInto(sandbox, `.opencode/skills/${name}/SKILL.md`, skillMarkdown(skill));
    for (const [path, content] of Object.entries(skill.files)) {
      yield* writeInto(sandbox, `.opencode/skills/${name}/${path}`, content);
    }
  }
  yield* writeInto(
    sandbox,
    "opencode.json",
    yield* encodeOpenCodeConfig(openCodeConfig(chat)).pipe(
      Effect.mapError((cause) => new SandboxError({ operation: "writeAgentSetup", cause })),
    ),
  );
});

/** How long packing or unpacking a workspace may take in the VM. */
const WORKSPACE_TAR_MILLIS = 90_000;

/**
 * Reads a running tar's output until it exits. Fails when tar does, except for GNU tar's 1, a file
 * that changed while it was read.
 */
const readTarball = (exec: ExecHandle) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let errors = "";
    let code: number | undefined;
    while (true) {
      const event = yield* sdk("pack", () => exec.recv());
      if (event === null) break;
      if (event.kind === "stdout") {
        chunks.push(event.data);
      } else if (event.kind === "stderr") {
        errors = (errors + new TextDecoder().decode(event.data)).slice(-2000);
      } else if (event.kind === "exited") {
        code = event.code;
      }
    }
    code ??= (yield* sdk("pack", () => exec.wait())).code;
    if (code > 1) {
      return yield* new SandboxError({
        operation: "pack",
        cause: new Error(`tar exited with ${code}: ${errors}`),
      });
    }
    return Bytes.concat(chunks);
  });

/** A port free on the host's loopback now, for a new VM to publish its server on. */
const freePort = NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
  Effect.map(({ address }) => (address._tag === "UnixPathAddress" ? 0 : address.port)),
  Effect.scoped,
  Effect.mapError((cause) => new SandboxError({ operation: "port", cause })),
);

const make = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  /**
   * VM names are short and plain whatever the chat id; the hash keeps them apart, and keeps one
   * runner's apart from another's on the same machine, which `.replace()` would otherwise remove.
   */
  const sandboxName = (chatId: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${config.port}/${chatId}`)).pipe(
      Effect.map((hash) => `chat-${Hex.encode(hash).slice(0, 32)}`),
      Effect.orDie,
    );
  /** The VMs this process started; held so it can stop them, and so they live as long as it. */
  const started = new Map<string, Sandbox>();

  /** OpenCode's client for a VM's server, signed in with its password. */
  const openCode = (server: Pick<ChatServer, "url" | "password">) =>
    OpenCode.make({ baseUrl: server.url }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(httpClient, HttpClientRequest.basicAuth("opencode", server.password)),
      ),
    );

  /**
   * The VM as the database holds it, or null when there is none; a failed lookup fails, so it is
   * never taken for a missing VM.
   */
  const find = (name: string) =>
    sdk("get", () => Sandbox.get(name)).pipe(
      Effect.catchIf(
        (error) => error.cause instanceof SandboxNotFoundError,
        () => Effect.succeed(null),
      ),
    );

  /** The running VM this process started for the chat. */
  const held = (chatId: string, operation: string) =>
    Effect.gen(function* () {
      const sandbox = started.get(yield* sandboxName(chatId));
      if (sandbox === undefined) {
        return yield* new SandboxError({
          operation,
          cause: new Error("The chat's VM isn't running."),
        });
      }
      return sandbox;
    });

  const create = Effect.fn("MicrosandboxChats.create")(function* (name: string, chat: RunConfig) {
    const hostPort = yield* freePort;
    const sandbox = yield* sdk("create", () =>
      Sandbox.builder(name)
        .image(config.image)
        .pullPolicy("if-missing")
        .user("agent")
        .security("restricted")
        .cpus(CHAT_LIMITS.cpus)
        .memory(CHAT_LIMITS.memoryMib)
        .rootDisk(CHAT_LIMITS.diskMib + 512)
        .labels(runnerLabels(config))
        .replace()
        .network(sandboxNetwork(config, chat.agent.permissions.network, hostPort))
        .create(),
    );
    yield* writeAgentSetup(sandbox, chat);
    return { sandbox, hostPort };
  });

  /**
   * Starts OpenCode with a fresh password and waits for its API and the agent's MCP servers.
   */
  const serve = Effect.fn("MicrosandboxChats.serve")(function* (
    sandbox: Sandbox,
    hostPort: number,
    chat: RunConfig,
  ) {
    const password = Redacted.make(
      Base64Url.encode(yield* crypto.randomBytes(24).pipe(Effect.orDie)),
    );
    yield* sdk("serve", () =>
      sandbox.execDetachedWith("sh", (exec) =>
        exec
          .args([
            "-c",
            `cd /work && exec opencode serve --hostname 0.0.0.0 --port ${GUEST_PORT} >/tmp/opencode-serve.log 2>&1`,
          ])
          .env("OPENCODE_PASSWORD", Redacted.value(password)),
      ),
    );
    const url = `http://127.0.0.1:${hostPort}`;
    const client = yield* openCode({ url, password });
    yield* client.server.info().pipe(
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
      Effect.mapError(
        (cause) =>
          new SandboxError({
            operation: "serve",
            cause: new Error("OpenCode did not start.", { cause }),
          }),
      ),
    );
    const servers = Object.keys(chat.agent.mcpServers);
    if (servers.length > 0) {
      yield* client.mcp.list().pipe(
        Effect.filterOrFail(({ data }) =>
          servers.every((name) =>
            data.some((server) => server.name === name && server.status.status === "connected"),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
        Effect.mapError(
          (cause) =>
            new SandboxError({
              operation: "serve",
              cause: new Error("The agent's MCP servers did not connect.", { cause }),
            }),
        ),
      );
    }
    const bootId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    return { bootId, url, password };
  });

  /** Stops the named VM and deletes it with its disk. */
  const removeNamed = Effect.fn("MicrosandboxChats.remove")(function* (name: string) {
    started.delete(name);
    const handle = yield* find(name);
    if (handle !== null) yield* sdk("remove", () => handle.destroy());
  });

  return ChatSandbox.of({
    health: Effect.gen(function* () {
      const kvm = yield* fileSystem.access("/dev/kvm", { readable: true, writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return kvm
        ? { isAvailable: true, reason: null }
        : { isAvailable: false, reason: "The runner can't use KVM, so it can't run sandboxes." };
    }),
    start: Effect.fn("MicrosandboxChats.start")(function* ({ chatId, chat }) {
      const name = yield* sandboxName(chatId);
      yield* removeNamed(name);
      const { sandbox, hostPort } = yield* create(name, chat);
      started.set(name, sandbox);
      return yield* serve(sandbox, hostPort, chat);
    }),
    write: ({ chatId, path, content }) =>
      held(chatId, "write").pipe(Effect.flatMap((sandbox) => writeInto(sandbox, path, content))),
    packWorkspace: (chatId) =>
      Effect.gen(function* () {
        const sandbox = yield* held(chatId, "pack");
        return yield* Effect.acquireUseRelease(
          sdk("pack", () =>
            sandbox.execStreamWith("tar", (exec) =>
              exec
                // A file the agent can't read is left out, not a reason to save nothing.
                .args([
                  "-czf",
                  "-",
                  "-C",
                  "/work",
                  "--ignore-failed-read",
                  ...WORKSPACE_EXCLUDES,
                  ".",
                ])
                .user("agent")
                .timeout(WORKSPACE_TAR_MILLIS),
            ),
          ),
          (exec) => readTarball(exec),
          // Stops a tar that is still writing, as when the save is interrupted.
          (exec) => sdk("pack", () => exec.kill()).pipe(Effect.ignore),
        );
      }),
    unpackWorkspace: ({ chatId, content }) =>
      Effect.gen(function* () {
        const sandbox = yield* held(chatId, "unpack");
        const fs = sandbox.fs();
        // Named so nothing in the VM can put a file or link there first.
        const upload = `/tmp/t45-workspace-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tgz`;
        yield* sdk("unpack", () => fs.write(upload, content));
        // As the agent and into /work: GNU tar leaves out members that would land outside it, and
        // keeps what this start wrote, so the agent's current setup wins over its saved copy.
        const output = yield* sdk("unpack", () =>
          sandbox.execWith("tar", (exec) =>
            exec
              .args(["-xzf", upload, "-C", "/work", "--skip-old-files"])
              .user("agent")
              .timeout(WORKSPACE_TAR_MILLIS),
          ),
        ).pipe(Effect.ensuring(sdk("unpack", () => fs.remove(upload)).pipe(Effect.ignore)));
        if (!output.success) {
          return yield* new SandboxError({
            operation: "unpack",
            cause: new Error(`tar exited with ${output.code}: ${output.stderr().slice(-2000)}`),
          });
        }
      }),
    serving: (server) =>
      openCode(server).pipe(
        Effect.flatMap((client) => client.server.info().pipe(Effect.timeout("5 seconds"))),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 2 }),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    remove: (chatId) => Effect.flatMap(sandboxName(chatId), removeNamed),
    sweep: Effect.gen(function* () {
      const handles: Array<SandboxHandle> = [];
      let cursor: string | undefined;
      do {
        const after = cursor;
        const page = yield* sdk("sweep", () =>
          Sandbox.listWith((list) => {
            const labelled = list.labels(runnerLabels(config));
            return after === undefined ? labelled : labelled.cursor(after);
          }),
        );
        handles.push(...page.sandboxes);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      for (const handle of handles) {
        yield* sdk("sweep", () => handle.destroy()).pipe(
          Effect.catchTags({
            SandboxError: (error) => Effect.logWarning("Clearing an old VM failed", error),
          }),
        );
      }
    }),
  });
});

export const layer = Layer.effect(ChatSandbox, make);
