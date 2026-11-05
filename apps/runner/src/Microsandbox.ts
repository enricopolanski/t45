import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { OpenCode } from "@opencode/client/effect";
import { Config } from "@opencode/schema/config";
import { AGENT_SETUP_PATHS } from "@t45/contracts/models/Agent";
import type { Execution } from "@t45/contracts/resources/Runner";
import * as Bytes from "effect/Bytes";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  type ExecHandle,
  type NetworkBuilder,
  NetworkPolicy,
  Sandbox as Microvm,
} from "microsandbox";

import { RunnerConfig } from "./RunnerConfig.ts";
import { Sandbox, SandboxError } from "./Sandbox.ts";

type Agent = Execution["agent"];

const GUEST_PORT = 4096;

const LIMITS = { cpus: 2, memoryMib: 2048, diskMib: 4096 };

/** The SDK types its network setter loosely; this is what it hands the callback. */
type NetworkSettings = InstanceType<typeof NetworkBuilder>;

const sdk = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SandboxError({ operation, cause }) });

/** The one host a provider-only network reaches, and the only one the key goes to. */
const PROVIDER_HOST = "opencode.ai";
/** Inside the VM it holds a placeholder. */
const KEY_ENV = "OPENCODE_API_KEY";

/**
 * Outbound denied but for the provider on 443, or the public internet less the runner's own
 * addresses, with DNS through the host. TLS interception is on and the key is a secret bound to the
 * provider. OpenCode's port binds to the host's loopback, so only the host reaches it.
 */
const sandboxNetwork =
  (config: RunnerConfig["Service"], network: Agent["permissions"]["network"], hostPort: number) =>
  (settings: NetworkSettings) => {
    let policy = NetworkPolicy.builder().defaultEgress("deny").defaultIngress("allow");
    if (network === "provider") {
      policy = policy.egress((rule) => rule.tcp().port(443).allowDomain(PROVIDER_HOST));
    } else {
      for (const ip of config.denyIps) {
        policy = policy.egress((rule) => rule.deny((to) => to.ip(ip)));
      }
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

const skillMarkdown = (skill: Agent["skills"][number]) =>
  `---\nname: ${skill.name}\ndescription: ${skill.description.replaceAll("\n", " ")}\n---\n\n${skill.content}`;

/** Encoded through OpenCode's schema, so a VM never boots on a config it refuses. */
const encodeOpenCodeConfig = Schema.encodeSync(
  Schema.fromJsonString(Schema.toEncoded(Config.Info)),
);

const openCodeConfig = (agent: Agent): typeof Config.Info.Encoded => {
  const fetching = agent.permissions.network === "provider" ? "deny" : "allow";
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "webfetch", resource: "*", effect: fetching },
      { action: "websearch", resource: "*", effect: fetching },
    ],
    mcp: { servers: agent.mcpServers },
  };
};

/** As root, making its folders. */
const writeInto = (vm: Microvm, relative: string, content: string | Uint8Array) => {
  const target = `/work/${relative}`;
  const fs = vm.fs();
  return sdk("mkdir", () => fs.mkdir(target.slice(0, target.lastIndexOf("/")))).pipe(
    Effect.andThen(sdk("write", () => fs.write(target, content))),
  );
};

const WORKSPACE_EXCLUDES = [
  "--anchored",
  ...AGENT_SETUP_PATHS.map((path) => `--exclude=./${path}`),
  "--exclude=./.opencode/skills",
  "--exclude=./.t45",
  "--exclude=./runtime",
  "--no-anchored",
  "--exclude=node_modules",
  "--exclude=.venv",
  "--exclude=__pycache__",
  "--exclude=.cache",
];

const WORKSPACE_INSTRUCTIONS = `Only /work survives when this sandbox stops, without attachments/ and caches such as node_modules, .venv, __pycache__ and .cache.`;

const writeAgentSetup = Effect.fn("Microsandbox.writeAgentSetup")(function* (
  vm: Microvm,
  agent: Agent,
) {
  const instructions = [agent.instructions, WORKSPACE_INSTRUCTIONS]
    .filter((text) => text.trim() !== "")
    .join("\n\n");
  yield* writeInto(vm, "AGENTS.md", instructions);
  for (const [path, content] of Object.entries(agent.files)) {
    yield* writeInto(vm, path, content);
  }
  for (const skill of agent.skills) {
    yield* writeInto(vm, `.opencode/skills/${skill.name}/SKILL.md`, skillMarkdown(skill));
    for (const [path, content] of Object.entries(skill.files)) {
      yield* writeInto(vm, `.opencode/skills/${skill.name}/${path}`, content);
    }
  }
  yield* writeInto(vm, "opencode.json", encodeOpenCodeConfig(openCodeConfig(agent)));
});

const WORKSPACE_TAR_MILLIS = 90_000;

/** GNU tar exits 1 for a file that changed while it was read, which still packs. */
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

const freePort = NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
  Effect.map(({ address }) => (address._tag === "UnixPathAddress" ? 0 : address.port)),
  Effect.scoped,
  Effect.mapError((cause) => new SandboxError({ operation: "port", cause })),
);

const make = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  /** OpenCode answers before its MCP servers connect, and a turn started then finds no tools. */
  const serve = Effect.fn("Microsandbox.serve")(function* (
    vm: Microvm,
    hostPort: number,
    agent: Agent,
  ) {
    const password = Redacted.make(
      Base64Url.encode(yield* crypto.randomBytes(24).pipe(Effect.orDie)),
    );
    yield* sdk("serve", () =>
      vm.execDetachedWith("sh", (exec) =>
        exec
          .args([
            "-c",
            `cd /work && exec opencode serve --hostname 0.0.0.0 --port ${GUEST_PORT} >/tmp/opencode-serve.log 2>&1`,
          ])
          .env("OPENCODE_PASSWORD", Redacted.value(password)),
      ),
    );
    const url = `http://127.0.0.1:${hostPort}`;
    const client = yield* OpenCode.make({ baseUrl: url }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(httpClient, HttpClientRequest.basicAuth("opencode", password)),
      ),
    );
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
    const servers = Object.keys(agent.mcpServers);
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
    return { url, password };
  });

  return Sandbox.of({
    start: Effect.fn("Microsandbox.start")(function* (id, agent) {
      const hostPort = yield* freePort;
      const vm = yield* Effect.acquireRelease(
        sdk("create", () =>
          // The port keeps one runner's VMs apart from another's on the same machine.
          Microvm.builder(`vm-${config.port}-${id}`)
            .image(config.image)
            .pullPolicy("if-missing")
            .user("agent")
            .security("restricted")
            .cpus(LIMITS.cpus)
            .memory(LIMITS.memoryMib)
            .rootDisk(LIMITS.diskMib + 512)
            // Removed by microsandbox once it stops, including when this runner dies.
            .ephemeral(true)
            .replace()
            .network(sandboxNetwork(config, agent.permissions.network, hostPort))
            .create(),
        ),
        (vm) =>
          sdk("remove", () => vm.destroy()).pipe(
            Effect.catch((error) => Effect.logWarning("Removing a VM failed", { id, error })),
          ),
      );
      yield* writeAgentSetup(vm, agent);
      return {
        ...(yield* serve(vm, hostPort, agent)),
        write: (path, content) => writeInto(vm, path, content),
        pack: sdk("pack", () =>
          vm.execStreamWith("tar", (exec) =>
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
        ).pipe(Effect.flatMap(readTarball)),
        unpack: (tarball) =>
          Effect.gen(function* () {
            const fs = vm.fs();
            // Named so nothing in the VM can put a file or link there first.
            const upload = `/tmp/t45-workspace-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tgz`;
            yield* sdk("unpack", () => fs.write(upload, tarball));
            // As the agent: GNU tar leaves out members that would land outside /work.
            const output = yield* sdk("unpack", () =>
              vm.execWith("tar", (exec) =>
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
      };
    }),
  });
});

export const layer = Layer.effect(Sandbox, make);
