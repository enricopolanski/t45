import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runDev } from "./dev.ts";
import * as PortProbe from "./lib/portProbe.ts";

function fixture(
  options: {
    env?: NodeJS.ProcessEnv;
    unavailable?: ReadonlyArray<number>;
    probeFailure?: PortProbe.PortProbeError;
    spawnFailure?: PlatformError.PlatformError;
    exit?: number | PlatformError.PlatformError;
  } = {},
) {
  const commands: Array<ChildProcess.StandardCommand> = [];
  const probes: Array<{ port: number; host: string }> = [];
  const exit = options.exit ?? 0;
  const layer = Layer.mergeAll(
    Layer.succeed(PortProbe.PortProbe, {
      canListenOnHost: (port, host) => {
        probes.push({ port, host });
        return options.probeFailure
          ? Effect.fail(options.probeFailure)
          : Effect.succeed(!options.unavailable?.includes(port));
      },
    }),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        assert.ok(ChildProcess.isStandardCommand(command));
        commands.push(command);
        if (options.spawnFailure) return Effect.fail(options.spawnFailure);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode:
              typeof exit === "number"
                ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
                : Effect.fail(exit),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );
  return {
    commands,
    probes,
    run: (input: Parameters<typeof runDev>[0] = {}) =>
      runDev(input, { cwd: "/repo", env: options.env ?? {} }).pipe(
        Effect.provide(layer),
        Effect.scoped,
      ),
    env: () => {
      const env = commands.at(-1)?.options.env;
      assert.ok(env);
      return env;
    },
  };
}

it.layer(NodeServices.layer)("dev", (it) => {
  it.effect(
    "launches web, server, and runner with matching connections and checkout-local state",
    () =>
      Effect.gen(function* () {
        const dev = fixture({
          env: {
            BUILD_SHA: "custom-build",
            DATA_DIR: "/home/user/.t3",
            T45_RUNNER_HOST: "192.0.2.1",
            T45_RUNNER_PORT: "9000",
          },
        });
        assert.equal(yield* dev.run(), 0);
        assert.deepStrictEqual(dev.commands[0]?.args, [
          "run",
          "--no-cache",
          "--filter=@t45/web",
          "--filter=t45",
          "--filter=@t45/runner",
          "--parallel",
          "dev",
        ]);
        assert.equal(dev.commands[0]?.command, "vp");
        const env = dev.env();
        assert.equal(env.BUILD_SHA, "custom-build");
        assert.equal(env.DATA_DIR, "/repo/.t3");
        assert.equal(env.PORT, "13773");
        assert.equal(env.WEB_PORT, "5733");
        assert.equal(env.T45_RUNNER_HOST, "127.0.0.1");
        assert.equal(env.T45_RUNNER_PORT, "8790");
        assert.equal(env.RUNNER_URL, `http://127.0.0.1:${env.T45_RUNNER_PORT}`);
        assert.ok(env.T45_RUNNER_TOKEN);
        assert.equal(env.RUNNER_TOKEN, env.T45_RUNNER_TOKEN);
      }),
  );

  it.effect("creates a fresh matching runner token on every launch", () =>
    Effect.gen(function* () {
      const dev = fixture({ env: { RUNNER_TOKEN: "ambient", T45_RUNNER_TOKEN: "ambient" } });
      yield* dev.run();
      const first = dev.env().RUNNER_TOKEN;
      yield* dev.run();
      assert.notEqual(first, "ambient");
      assert.notEqual(dev.env().RUNNER_TOKEN, first);
      assert.equal(dev.env().RUNNER_TOKEN, dev.env().T45_RUNNER_TOKEN);
    }),
  );

  it.effect.each([13773, 5733, 8790])("moves all local ports when %s is occupied", (occupied) =>
    Effect.gen(function* () {
      const dev = fixture({ unavailable: [occupied] });
      yield* dev.run();
      assert.equal(dev.env().PORT, "13774");
      assert.equal(dev.env().WEB_PORT, "5734");
      assert.equal(dev.env().T45_RUNNER_PORT, "8791");
      assert.equal(dev.env().RUNNER_URL, "http://127.0.0.1:8791");
    }),
  );

  it.effect.each([267, 833])("skips browser-blocked web ports at offset %s", (offset) =>
    Effect.gen(function* () {
      const dev = fixture({ env: { PORT_OFFSET: String(offset) } });
      yield* dev.run();
      assert.equal(dev.env().WEB_PORT, String(5733 + offset + 1));
      assert.equal(dev.env().PORT, String(13773 + offset + 1));
    }),
  );

  it.effect("honors a preferred offset", () =>
    Effect.gen(function* () {
      const dev = fixture({ env: { PORT_OFFSET: "100" } });
      yield* dev.run();
      assert.equal(dev.env().PORT, "13873");
      assert.equal(dev.env().WEB_PORT, "5833");
      assert.equal(dev.env().T45_RUNNER_PORT, "8890");
    }),
  );

  it.effect("keeps an explicit server port fixed while the other ports move", () =>
    Effect.gen(function* () {
      const dev = fixture({ env: { PORT: "13773" }, unavailable: [8790] });
      yield* dev.run({ port: 4222 });
      assert.equal(dev.env().PORT, "4222");
      assert.equal(dev.env().WEB_PORT, "5734");
      assert.equal(dev.env().T45_RUNNER_PORT, "8791");
    }),
  );

  it.effect.each([5733, 8790])("avoids sharing server port %s with another service", (port) =>
    Effect.gen(function* () {
      const dev = fixture();
      yield* dev.run({ port });
      assert.equal(dev.env().PORT, String(port));
      assert.equal(dev.env().WEB_PORT, "5734");
      assert.equal(dev.env().T45_RUNNER_PORT, "8791");
    }),
  );

  it.effect("fails immediately when the fixed server port is occupied", () =>
    Effect.gen(function* () {
      const dev = fixture({ env: { PORT: "4222" }, unavailable: [4222] });
      const error = yield* dev.run().pipe(Effect.flip);
      assert.equal(error._tag, "DevPortSelectionError");
      assert.equal(dev.probes.length, 1);
      assert.isEmpty(dev.commands);
    }),
  );

  it.effect("uses a shared runner without launching or probing a local runner", () =>
    Effect.gen(function* () {
      const dev = fixture({
        env: {
          RUNNER_URL: "http://runner.invalid:8790",
          RUNNER_TOKEN: "shared-token",
        },
        unavailable: [8790],
      });
      yield* dev.run();
      assert.deepStrictEqual(dev.commands[0]?.args, [
        "run",
        "--no-cache",
        "--filter=@t45/web",
        "--filter=t45",
        "--parallel",
        "dev",
      ]);
      assert.equal(dev.env().RUNNER_URL, "http://runner.invalid:8790/");
      assert.equal(dev.env().RUNNER_TOKEN, "shared-token");
      assert.equal(dev.env().WEB_PORT, "5733");
      assert.ok(dev.probes.every(({ port }) => port !== 8790));
    }),
  );

  it.effect.each([
    { PORT_OFFSET: "-1" },
    { PORT_OFFSET: "51763" },
    { PORT_OFFSET: "not-an-integer" },
    { PORT: "0" },
    { HOST: "192.0.2.1" },
    { RUNNER_URL: "not-a-url", RUNNER_TOKEN: "token" },
    { RUNNER_URL: "http://runner.invalid" },
    { RUNNER_URL: "http://runner.invalid", RUNNER_TOKEN: " " },
  ])("rejects invalid configuration before probing or starting services: %j", (env) =>
    Effect.gen(function* () {
      const dev = fixture({ env });
      const error = yield* dev.run().pipe(Effect.flip);
      assert.equal(error._tag, "DevConfigurationError");
      assert.isEmpty(dev.probes);
      assert.isEmpty(dev.commands);
    }),
  );

  it.effect("reports port exhaustion without generating out-of-range ports", () =>
    Effect.gen(function* () {
      const dev = fixture({ env: { PORT_OFFSET: "51762" }, unavailable: [65535] });
      const error = yield* dev.run().pipe(Effect.flip);
      assert.equal(error._tag, "DevPortSelectionError");
      assert.ok(dev.probes.every(({ port }) => port <= 65535));
      assert.isEmpty(dev.commands);
    }),
  );

  it.effect("probes a wildcard server host without applying it to the web or runner", () =>
    Effect.gen(function* () {
      const dev = fixture();
      yield* dev.run({ host: "0.0.0.0" });
      assert.equal(dev.env().HOST, "0.0.0.0");
      assert.ok(dev.probes.some(({ port, host }) => port === 13773 && host === "0.0.0.0"));
      assert.ok(dev.probes.every(({ port, host }) => host !== "0.0.0.0" || port === 13773));
    }),
  );

  it.effect.each([undefined, "   ", "/tmp/disposable-dev"])(
    "selects the state directory for --home-dir %j",
    (homeDir) =>
      Effect.gen(function* () {
        const dev = fixture({ env: { DATA_DIR: "/home/user/.t3" } });
        yield* dev.run({ homeDir });
        assert.equal(dev.env().DATA_DIR, homeDir?.trim() || "/repo/.t3");
      }),
  );

  it.effect.each([undefined, "0", "1"])(
    "logs requests unless the environment setting %j says otherwise",
    (value) =>
      Effect.gen(function* () {
        const dev = fixture({ env: { LOG_REQUESTS: value } });
        yield* dev.run();
        assert.equal(dev.env().LOG_REQUESTS, value ?? "true");
      }),
  );

  it.effect("does not start services on a dry run", () =>
    Effect.gen(function* () {
      const dev = fixture();
      assert.equal(yield* dev.run({ dryRun: true }), 0);
      assert.isNotEmpty(dev.probes);
      assert.isEmpty(dev.commands);
    }),
  );

  it.effect("stops immediately on unexpected socket errors", () =>
    Effect.gen(function* () {
      const cause = new PortProbe.PortProbeError({
        port: 5733,
        host: "127.0.0.1",
        cause: new Error("permission denied"),
      });
      const dev = fixture({ probeFailure: cause });
      assert.equal(yield* dev.run().pipe(Effect.flip), cause);
      assert.equal(dev.probes.length, 1);
      assert.isEmpty(dev.commands);
    }),
  );

  it.effect("returns the child exit code", () =>
    Effect.gen(function* () {
      const dev = fixture({ exit: 17 });
      assert.equal(yield* dev.run(), 17);
    }),
  );

  it.effect.each(["spawn", "wait-for-exit"] as const)(
    "preserves the cause of a %s failure",
    (operation) =>
      Effect.gen(function* () {
        const cause = PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: operation,
        });
        const dev = fixture(operation === "spawn" ? { spawnFailure: cause } : { exit: cause });
        const error = yield* dev.run().pipe(Effect.flip);
        assert.equal(error._tag, "DevProcessError");
        if (error._tag === "DevProcessError") assert.equal(error.cause, cause);
      }),
  );
});
