import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { CAPABILITIES_DIR } from "@t45/contracts/models/Capability";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { generateId } from "@t45/contracts/models/primitives";
import {
  ExecutionFailed,
  SCRIPT_INPUT_FILE,
  SCRIPT_OUTPUT_FILE,
  SCRIPT_TEMPLATE_FILE,
  type ScriptFileRequest,
  ScriptOutputs,
  ScriptRequest,
} from "@t45/contracts/resources/Runner";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type NetworkBuilder, NetworkPolicy, Sandbox as Microvm } from "microsandbox";
import {
  type AgentSetup,
  agentSetupFiles,
  KEY_ENV,
  mergeCapabilityFiles,
  PROVIDER_HOST,
  secretPlaceholder,
  TOOL_TOKEN_ENV,
  TOOL_TOKEN_PLACEHOLDER,
} from "./AgentSetup.ts";

type Agent = AgentSetup;

class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The sandbox's ${this.operation} failed.`;
  }
}

/** Built by `image/build-local.sh`. */
const IMAGE = "t45-agent:dev";

const GUEST_PORT = 4096;

const LIMITS = { cpus: 2, memoryMib: 2048, diskMib: 4096 };

/** The VM's writable layer, an ext4 file on the host, and the archive it travels in. */
const DISK = "disk.raw";
const ARCHIVE = "disk.tgz";

/** Agent setup is written again at every start. */
const STALE = ["/work/.opencode/skills", CAPABILITIES_DIR];

/** The SDK types its network setter loosely; this is what it hands the callback. */
type NetworkSettings = InstanceType<typeof NetworkBuilder>;

const sdk = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SandboxError({ operation, cause }) });

/**
 * Outbound denied but for the provider on 443, or the public internet with DNS through the host,
 * plus the T45 server and the hosts the agent's capabilities name. TLS interception is on and each
 * credential is a secret bound to its hosts, so the VM holds only placeholders. OpenCode's port
 * binds to the host's loopback, so only the host reaches it.
 */
const sandboxNetwork =
  (
    openCodeKey: Redacted.Redacted,
    agent: Agent,
    hostPort: number,
    serverUrl: string,
    toolToken: Redacted.Redacted,
    secretValues: ReadonlyMap<string, Redacted.Redacted>,
  ) =>
  (settings: NetworkSettings) => {
    let policy = NetworkPolicy.builder().defaultEgress("deny").defaultIngress("allow");
    if (agent.permissions.network === "provider") {
      policy = policy.egress((rule) => rule.tcp().port(443).allowDomain(PROVIDER_HOST));
    } else {
      policy = policy.egress((rule) => rule.udp().tcp().port(53).allowHost());
      policy = policy.egress((rule) => rule.allowPublic());
    }
    for (const host of agent.hosts) {
      policy = policy.egress((rule) => rule.tcp().port(443).allowDomain(host));
    }
    const endpoint = new URL(serverUrl);
    policy = policy.egress((rule) => {
      const target = rule
        .tcp()
        .port(Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)));
      return endpoint.hostname === "host.microsandbox.internal"
        ? target.allowHost()
        : target.allowDomain(endpoint.hostname);
    });
    let configured = settings
      .policyFromBuilder(policy)
      .secret((secret) =>
        secret
          .env(KEY_ENV)
          .value(Redacted.value(openCodeKey))
          .allow(PROVIDER_HOST)
          .substituteInHeaderFields(["authorization", "x-api-key"]),
      )
      // Over plain HTTP no TLS identity vouches for the server, so its host alone decides.
      // Placeholders the agent reads (in a config file, its environment) end up in the
      // conversation, so the provider receives them unchanged instead of blocking the chat.
      .secret((secret) =>
        secret
          .env(TOOL_TOKEN_ENV)
          .value(Redacted.value(toolToken))
          .placeholder(TOOL_TOKEN_PLACEHOLDER)
          .allow(endpoint.hostname)
          .allowPlaceholderFor(PROVIDER_HOST)
          .requireTlsIdentity(endpoint.protocol === "https:")
          .substituteInHeaderFields(["authorization"]),
      );
    for (const [name, hosts] of agent.secrets) {
      configured = configured.secret((secret) =>
        hosts.reduce(
          (entry, host) => entry.allow(host),
          secret
            .env(name)
            .value(Redacted.value(secretValues.get(name)!))
            .placeholder(secretPlaceholder(name))
            .allowPlaceholderFor(PROVIDER_HOST)
            .substituteInHeaders(true),
        ),
      );
    }
    return configured.portBind("127.0.0.1", hostPort, GUEST_PORT).tls((tls) => tls);
  };

/** As root, making its folders. */
const write = (vm: Microvm, target: string, content: string | Uint8Array) => {
  const fs = vm.fs();
  return sdk("mkdir", () => fs.mkdir(target.slice(0, target.lastIndexOf("/")))).pipe(
    Effect.andThen(sdk("write", () => fs.write(target, content))),
  );
};

const decodeScriptOutputs = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptOutputs));
const encodeScriptInputs = Schema.encodeSync(Schema.fromJsonString(ScriptRequest.fields.inputs));

const executeScript = Effect.fnUntraced(
  function* (request: ScriptRequest | ScriptFileRequest) {
    if (
      !Object.hasOwn(request.files, request.entrypoint) ||
      !/\.(?:js|mjs|ts)$/u.test(request.entrypoint)
    )
      return yield* new ExecutionFailed({
        reason: "Choose a JavaScript or TypeScript file from the calculation files.",
      });

    const vm = yield* Effect.acquireRelease(
      sdk("create", () =>
        Microvm.builder(`calculation-${generateId()}`)
          .image(IMAGE)
          .pullPolicy("if-missing")
          .user("agent")
          .security("restricted")
          .cpus(1)
          .memory(512)
          .ephemeral(true)
          .network((settings) =>
            settings.policyFromBuilder(
              NetworkPolicy.builder().defaultEgress("deny").defaultIngress("deny"),
            ),
          )
          .create(),
      ),
      (vm) => sdk("remove", () => vm.destroy()).pipe(Effect.catch(Effect.logWarning)),
    );
    const input = `/work/${SCRIPT_INPUT_FILE}`;
    yield* write(vm, input, encodeScriptInputs(request.inputs));
    for (const [path, content] of Object.entries(request.files))
      yield* write(vm, `/work/${path}`, content);
    if ("template" in request) {
      for (const [path, content] of mergeCapabilityFiles(request.capabilityFiles))
        yield* write(vm, `${CAPABILITIES_DIR}/${path}`, content);
      yield* write(vm, `/work/${SCRIPT_TEMPLATE_FILE}`, request.template);
    }
    const output = yield* sdk("run script", () =>
      vm.execWith("node", (exec) =>
        exec
          .args([`/work/${request.entrypoint}`, input])
          .cwd("/work")
          .timeout(30_000),
      ),
    );
    if (!output.success)
      return yield* new ExecutionFailed({
        reason: `The calculation exited with code ${output.code}.`,
      });
    return { vm, output };
  },
  Effect.mapError((error) =>
    error._tag === "ExecutionFailed" ? error : new ExecutionFailed({ reason: error.message }),
  ),
);

export const runScript = Effect.fn("SandboxManager.runScript")(function* (request: ScriptRequest) {
  const { output } = yield* executeScript(request);
  return yield* decodeScriptOutputs(output.stdout()).pipe(
    Effect.mapError(
      () =>
        new ExecutionFailed({
          reason: "The calculation must print its outputs as a JSON object.",
        }),
    ),
  );
}, Effect.scoped);

export const runScriptForFile = Effect.fn("SandboxManager.runScriptForFile")(function* (
  request: ScriptFileRequest,
) {
  const { vm } = yield* executeScript(request);
  const output = `/work/${SCRIPT_OUTPUT_FILE}`;
  const fs = vm.fs();
  return yield* Effect.tryPromise({
    try: async () => {
      const info = await fs.stat(output);
      if (info.kind !== "file" || info.size === 0 || info.size > ATTACHMENT_MAX_FILE_BYTES)
        throw new Error("Invalid script output file");
      // Hold at most the stated size even if the guest changes the file after stat.
      const bytes = new Uint8Array(info.size);
      let length = 0;
      await using stream = await fs.readStream(output);
      for await (const chunk of stream) {
        bytes.set(chunk, length);
        length += chunk.byteLength;
      }
      if (length !== bytes.length) throw new Error("Script output file changed");
      return bytes;
    },
    catch: () =>
      new ExecutionFailed({
        reason: `The script must write a file to ${SCRIPT_OUTPUT_FILE} within the attachment size limit.`,
      }),
  });
}, Effect.scoped);

const writeAgentSetup = Effect.fn("SandboxManager.writeAgentSetup")(function* (
  vm: Microvm,
  agent: Agent,
) {
  const cleared = yield* sdk("setup", () =>
    vm.execWith("rm", (exec) => exec.args(["-rf", ...STALE]).user("root")),
  );
  if (!cleared.success) {
    return yield* new SandboxError({ operation: "setup", cause: cleared.stderr() });
  }
  for (const [path, content] of agentSetupFiles(agent)) yield* write(vm, path, content);
});

const freePort = NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
  Effect.map(({ address }) => (address._tag === "UnixPathAddress" ? 0 : address.port)),
  Effect.scoped,
  Effect.mapError((cause) => new SandboxError({ operation: "port", cause })),
);

/**
 * A VM on the disk, removed when its scope closes, with `opencode serve` launched in it for the
 * agent. OpenCode answers at `url` with `password` once it has booted.
 */
export const start = Effect.fn("SandboxManager.start")(function* (
  rootId: string,
  agent: Agent,
  saved: Uint8Array | null,
  serverUrl: string,
  toolToken: Redacted.Redacted,
) {
  const runnerPort = yield* Config.Port("T45_RUNNER_PORT");
  const openCodeKey = yield* Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "OPENCODE_API_KEY",
  );
  const secretValues = new Map<string, Redacted.Redacted>();
  for (const name of agent.secrets.keys()) {
    secretValues.set(
      name,
      yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), `CAPABILITY_SECRET_${name}`),
    );
  }
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

  const hostPort = yield* freePort;
  const disk = yield* prepareDisk(saved);
  const { vm, remove } = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const vm = yield* sdk("create", () =>
        // The port keeps one runner's VMs apart from another's on the same machine.
        Microvm.builder(`vm-${runnerPort}-${rootId}`)
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
          .network(sandboxNetwork(openCodeKey, agent, hostPort, serverUrl, toolToken, secretValues))
          .create(),
      );
      return { vm, remove: yield* Effect.cached(sdk("remove", () => vm.destroy())) };
    }),
    ({ remove }) =>
      remove.pipe(
        Effect.catch((error) => Effect.logWarning("Removing a VM failed", { rootId, error })),
      ),
  );
  yield* writeAgentSetup(vm, agent);
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
        .env("OPENCODE_PASSWORD", Redacted.value(password))
        .envs(agent.environment),
    ),
  );
  return {
    url: `http://127.0.0.1:${hostPort}`,
    password,
    write: (path: string, content: Uint8Array) => write(vm, `/work/${path}`, content),
    // Only a removed VM has flushed its disk.
    save: remove.pipe(Effect.andThen(disk.save)),
  };
});
