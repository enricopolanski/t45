#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";

import * as PortProbe from "./lib/portProbe.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const BASE_PORTS = { server: 13773, web: 5733, runner: 8790 };
const MAX_OFFSET = 65535 - Math.max(...Object.values(BASE_PORTS));
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
const BIND_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"] as const;
// Browsers reject these ports even when a TCP listener can bind them.
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

class DevConfigurationError extends Schema.TaggedError<DevConfigurationError>()(
  "DevConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Invalid development configuration: check the port offset, server bind host/port, and shared runner URL/token.";
  }
}

class DevPortSelectionError extends Schema.TaggedError<DevPortSelectionError>()(
  "DevPortSelectionError",
  { startOffset: Schema.Number, serverPort: Schema.optional(Schema.Number) },
) {
  override get message() {
    return this.serverPort === undefined
      ? `No development ports available from offset ${this.startOffset}.`
      : `Could not select development ports with server port ${this.serverPort} fixed.`;
  }
}

class DevProcessError extends Schema.TaggedError<DevProcessError>()("DevProcessError", {
  operation: Schema.Literals(["spawn", "wait-for-exit"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Development process operation "${this.operation}" failed.`;
  }
}

const canBind = Effect.fnUntraced(function* (port: number, hosts: ReadonlyArray<string>) {
  const probe = yield* PortProbe.PortProbe;
  // Probe overlapping bind addresses sequentially so probes cannot conflict with each other.
  for (const host of hosts) {
    if (!(yield* probe.canListenOnHost(port, host))) return false;
  }
  return true;
});

const selectPorts = Effect.fnUntraced(function* (config: {
  readonly offset: number;
  readonly host: string;
  readonly port: number | undefined;
  readonly localRunner: boolean;
}) {
  const serverHosts = [...new Set([...LOOPBACK_HOSTS, config.host])];
  if (config.port !== undefined && !(yield* canBind(config.port, serverHosts))) {
    return yield* new DevPortSelectionError({
      startOffset: config.offset,
      serverPort: config.port,
    });
  }

  nextOffset: for (let offset = config.offset; offset <= MAX_OFFSET; offset += 1) {
    const ports = {
      server: config.port ?? BASE_PORTS.server + offset,
      web: BASE_PORTS.web + offset,
      runner: BASE_PORTS.runner + offset,
    };
    if (FETCH_BAD_PORTS.has(ports.web)) continue;
    const activePorts = [ports.server, ports.web, ...(config.localRunner ? [ports.runner] : [])];
    if (new Set(activePorts).size !== activePorts.length) continue;

    const listeners = [{ port: ports.web, hosts: LOOPBACK_HOSTS }];
    if (config.port === undefined) listeners.push({ port: ports.server, hosts: serverHosts });
    if (config.localRunner) listeners.push({ port: ports.runner, hosts: ["127.0.0.1"] });
    for (const listener of listeners) {
      if (!(yield* canBind(listener.port, listener.hosts))) continue nextOffset;
    }
    return ports;
  }
  return yield* new DevPortSelectionError({ startOffset: config.offset, serverPort: config.port });
});

export const runDev = Effect.fnUntraced(function* (
  input: {
    readonly homeDir?: string | undefined;
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly dryRun?: boolean | undefined;
  },
  launch = { cwd: process.cwd(), env: loadRepoEnv() },
) {
  const baseEnv = {
    ...launch.env,
    ...(input.host !== undefined ? { HOST: input.host } : {}),
    ...(input.port !== undefined ? { PORT: String(input.port) } : {}),
    RUNNER_URL: launch.env.RUNNER_URL?.trim(),
    RUNNER_TOKEN: launch.env.RUNNER_TOKEN?.trim(),
  };
  const localRunner = !baseEnv.RUNNER_URL;
  const config = yield* Config.all({
    offset: Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_OFFSET })),
      "PORT_OFFSET",
    ).pipe(Config.withDefault(0)),
    host: Config.schema(Schema.Literals(BIND_HOSTS), "HOST").pipe(Config.withDefault("127.0.0.1")),
    port: Config.Port("PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
    runnerUrl: localRunner ? Config.succeed(undefined) : Config.URL("RUNNER_URL"),
    runnerToken: localRunner
      ? Config.succeed(undefined)
      : Config.schema(Schema.NonEmptyString, "RUNNER_TOKEN").pipe(Config.map(Redacted.make)),
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: baseEnv }))),
    Effect.mapError((cause) => new DevConfigurationError({ cause })),
  );
  const ports = yield* selectPorts({ ...config, localRunner });
  const path = yield* Path.Path;
  // Ignore ambient DATA_DIR so a parent application cannot redirect dev into its live data.
  const homeDir = path.resolve(input.homeDir?.trim() || path.join(launch.cwd, ".t3"));
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    DATA_DIR: homeDir,
    HOST: config.host,
    PORT: String(ports.server),
    WEB_PORT: String(ports.web),
    LOG_REQUESTS: baseEnv.LOG_REQUESTS ?? "true",
  };
  if (localRunner) {
    const token = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
    env.T45_RUNNER_HOST = "127.0.0.1";
    env.T45_RUNNER_PORT = String(ports.runner);
    env.T45_RUNNER_TOKEN = token;
    env.RUNNER_URL = `http://127.0.0.1:${ports.runner}`;
    env.RUNNER_TOKEN = token;
  } else {
    env.RUNNER_URL = config.runnerUrl?.toString();
    env.RUNNER_TOKEN = config.runnerToken && Redacted.value(config.runnerToken);
  }

  yield* Effect.logInfo(
    `[dev-runner] serverPort=${ports.server} webPort=${ports.web} runnerUrl=${config.runnerUrl?.origin ?? env.RUNNER_URL} baseDir=${homeDir}`,
  );
  if (input.dryRun) return 0;

  const args = ["run", "--no-cache", "--filter=@t45/web", "--filter=t45"];
  if (localRunner) args.push("--filter=@t45/runner");
  args.push("--parallel", "dev");
  const child = yield* ChildProcess.make("vp", args, {
    cwd: launch.cwd,
    env,
    extendEnv: false,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // Terminal signals reach Vite+ directly; the scope cleans it up on other interruptions.
    detached: false,
    forceKillAfter: "1500 millis",
  }).pipe(Effect.mapError((cause) => new DevProcessError({ operation: "spawn", cause })));
  return yield* child.exitCode.pipe(
    Effect.mapError((cause) => new DevProcessError({ operation: "wait-for-exit", cause })),
  );
});

const cli = Command.make("dev", {
  homeDir: Flag.String("home-dir").pipe(
    Flag.withDescription("State directory; defaults to this checkout's .t3."),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("Server bind host: loopback or a wildcard."),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Fixed server port; otherwise selected automatically."),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the selected configuration without starting services."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Start the web, server, and agent runner together."),
  Command.withHandler((input) =>
    runDev(input).pipe(
      Effect.tap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        }),
      ),
    ),
  ),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, PortProbe.layer, Logger.layer([Logger.consolePretty()])),
    ),
    NodeRuntime.runMain,
  );
}
