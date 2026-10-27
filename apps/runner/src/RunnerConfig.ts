/*
 * The runner's settings, from its environment:
 *
 *   T45_RUNNER_HOST, T45_RUNNER_PORT   where it listens (127.0.0.1:8790 by default)
 *   T45_RUNNER_TOKEN                   the bearer token T45 sends; required
 *   T45_RUNNER_IMAGE                   the agent image (t45-agent:dev by default)
 *   T45_RUNNER_SANDBOX_POOL            sandbox addresses (10.200.0.0/16 by default)
 *   T45_RUNNER_DENY_IPS                public addresses an open network refuses, comma-separated
 *   OPENCODE_API_KEY                   the OpenCode Go key agents' models run on; required
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class RunnerConfig extends Context.Service<
  RunnerConfig,
  {
    readonly host: string;
    readonly port: number;
    readonly token: Redacted.Redacted;
    readonly image: string;
    readonly ipv4Pool: string;
    readonly denyIps: ReadonlyArray<string>;
    /** Signs VMs in to OpenCode Go; inside a VM, OpenCode only sees a placeholder. */
    readonly openCodeKey: Redacted.Redacted;
  }
>()("@t45/runner/RunnerConfig") {}

/** A secret the runner can't start without; `why` says what it is for. */
const required = (name: string, why: string) =>
  Effect.gen(function* () {
    const value = yield* Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));
    if (Redacted.value(value).trim() === "") {
      return yield* Effect.die(`${name} is required: ${why}`);
    }
    return value;
  });

const make = Effect.gen(function* () {
  const token = yield* required("T45_RUNNER_TOKEN", "T45 sends it as its bearer token.");
  const openCodeKey = yield* required("OPENCODE_API_KEY", "agents' models run on OpenCode Go.");
  return RunnerConfig.of({
    host: yield* Config.String("T45_RUNNER_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: yield* Config.Port("T45_RUNNER_PORT").pipe(Config.withDefault(8790)),
    token,
    image: yield* Config.String("T45_RUNNER_IMAGE").pipe(Config.withDefault("t45-agent:dev")),
    ipv4Pool: yield* Config.String("T45_RUNNER_SANDBOX_POOL").pipe(
      Config.withDefault("10.200.0.0/16"),
    ),
    denyIps: (yield* Config.String("T45_RUNNER_DENY_IPS").pipe(Config.withDefault("")))
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
    openCodeKey,
  });
});

export const layer = Layer.effect(RunnerConfig, make);
