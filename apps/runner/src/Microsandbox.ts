import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { OpenCode } from "@opencode/client/effect";
import { Config } from "@opencode/schema/config";
import type { Execution } from "@t45/contracts/resources/Runner";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type NetworkBuilder, NetworkPolicy, Sandbox as Microvm } from "microsandbox";

import * as RunnerConfig from "./RunnerConfig.ts";
import { Sandbox, SandboxError } from "./Sandbox.ts";

type Agent = Execution["agent"];

/** Built by `image/build-local.sh`. */
const IMAGE = "t45-agent:dev";

const GUEST_PORT = 4096;

const LIMITS = { cpus: 2, memoryMib: 2048, diskMib: 4096 };

/** The VM's writable layer, an ext4 file on the host, and the archive it travels in. */
const DISK = "disk.raw";
const ARCHIVE = "disk.tgz";

/** Written again at every start, or left by the step tools for the last execution. */
const STALE = ["/work/.opencode/skills", "/work/runtime", "/work/.t45"];

/** The SDK types its network setter loosely; this is what it hands the callback. */
type NetworkSettings = InstanceType<typeof NetworkBuilder>;

const sdk = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SandboxError({ operation, cause }) });

/** The one host a provider-only network reaches, and the only one the key goes to. */
const PROVIDER_HOST = "opencode.ai";
/** Inside the VM it holds a placeholder. */
const KEY_ENV = "OPENCODE_API_KEY";

/**
 * Outbound denied but for the provider on 443, or the public internet with DNS through the host. TLS interception is on and the key is a secret bound to the
 * provider. OpenCode's port binds to the host's loopback, so only the host reaches it.
 */
const sandboxNetwork =
  (openCodeKey: Redacted.Redacted, network: Agent["permissions"]["network"], hostPort: number) =>
  (settings: NetworkSettings) => {
    let policy = NetworkPolicy.builder().defaultEgress("deny").defaultIngress("allow");
    if (network === "provider") {
      policy = policy.egress((rule) => rule.tcp().port(443).allowDomain(PROVIDER_HOST));
    } else {
      policy = policy.egress((rule) => rule.udp().tcp().port(53).allowHost());
      policy = policy.egress((rule) => rule.allowPublic());
    }
    return settings
      .policyFromBuilder(policy)
      .tls((tls) => tls)
      .secret((secret) =>
        secret
          .env(KEY_ENV)
          .value(Redacted.value(openCodeKey))
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

const writeAgentSetup = Effect.fn("Microsandbox.writeAgentSetup")(function* (
  vm: Microvm,
  agent: Agent,
) {
  const cleared = yield* sdk("setup", () =>
    vm.execWith("rm", (exec) => exec.args(["-rf", ...STALE]).user("root")),
  );
  if (!cleared.success) {
    return yield* new SandboxError({ operation: "setup", cause: cleared.stderr() });
  }
  yield* writeInto(vm, "AGENTS.md", agent.instructions);
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

const freePort = NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
  Effect.map(({ address }) => (address._tag === "UnixPathAddress" ? 0 : address.port)),
  Effect.scoped,
  Effect.mapError((cause) => new SandboxError({ operation: "port", cause })),
);

const make = Effect.gen(function* () {
  const port = yield* RunnerConfig.port;
  const openCodeKey = yield* RunnerConfig.openCodeKey;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const onHost = (command: string, args: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make(command, args, { stderr: "inherit" })).pipe(
      Effect.filterOrFail(
        (code) => code === 0,
        (code) => new SandboxError({ operation: command, cause: `It exited with ${code}.` }),
      ),
    );

  /** A sparse file the VM's scope removes after the VM: the saved disk, or a new one. */
  const prepareDisk = (saved: Uint8Array | null) =>
    Effect.gen(function* () {
      // Not /tmp, which is often memory.
      const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp" });
      const file = path.join(directory, DISK);
      const archive = path.join(directory, ARCHIVE);
      if (saved === null) {
        const lazy = ["-E", "lazy_itable_init=1,lazy_journal_init=1"];
        yield* onHost("mkfs.ext4", ["-q", "-m", "0", ...lazy, file, `${LIMITS.diskMib + 512}M`]);
      } else {
        yield* fileSystem.writeFile(archive, saved);
        yield* onHost("tar", ["-xzf", archive, "-C", directory]);
      }
      const save = onHost("tar", ["-cSzf", archive, "-C", directory, DISK]).pipe(
        Effect.andThen(fileSystem.readFile(archive)),
        Effect.mapError((cause) => new SandboxError({ operation: "save", cause })),
      );
      return { file, save };
    }).pipe(Effect.mapError((cause) => new SandboxError({ operation: "disk", cause })));

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
    start: Effect.fn("Microsandbox.start")(function* (id, agent, saved) {
      const hostPort = yield* freePort;
      const disk = yield* prepareDisk(saved);
      const { vm, remove } = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const vm = yield* sdk("create", () =>
            // The port keeps one runner's VMs apart from another's on the same machine.
            Microvm.builder(`vm-${port}-${id}`)
              .image(IMAGE)
              .pullPolicy("if-missing")
              .user("agent")
              .security("restricted")
              .cpus(LIMITS.cpus)
              .memory(LIMITS.memoryMib)
              .rootDisk((root) => root.disk(disk.file).format("raw").fstype("ext4"))
              // Removed by microsandbox once it stops, including when this runner dies.
              .ephemeral(true)
              .replace()
              .network(sandboxNetwork(openCodeKey, agent.permissions.network, hostPort))
              .create(),
          );
          return { vm, remove: yield* Effect.cached(sdk("remove", () => vm.destroy())) };
        }),
        ({ remove }) =>
          remove.pipe(
            Effect.catch((error) => Effect.logWarning("Removing a VM failed", { id, error })),
          ),
      );
      yield* writeAgentSetup(vm, agent);
      return {
        ...(yield* serve(vm, hostPort, agent)),
        write: (path, content) => writeInto(vm, path, content),
        // Only a removed VM has flushed its disk.
        save: remove.pipe(Effect.andThen(disk.save)),
      };
    }),
  });
});

export const layer = Layer.effect(Sandbox, make);
