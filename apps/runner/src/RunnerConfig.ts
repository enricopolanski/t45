import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The runner's settings, from its environment, all required. */
export class RunnerConfig extends Context.Service<
  RunnerConfig,
  {
    /** `T45_RUNNER_HOST`: where it listens. */
    readonly host: string;
    /** `T45_RUNNER_PORT`: where it listens. */
    readonly port: number;
    /** `T45_RUNNER_TOKEN`: the bearer token T45 sends. */
    readonly token: Redacted.Redacted;
    /** `OPENCODE_API_KEY`: the OpenCode Go key agents' models run on. */
    readonly openCodeKey: Redacted.Redacted;
  }
>()("@t45/runner/RunnerConfig") {}

const secret = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const layer = Layer.effect(
  RunnerConfig,
  Config.all({
    host: Config.schema(Schema.NonEmptyString, "T45_RUNNER_HOST"),
    port: Config.Port("T45_RUNNER_PORT"),
    token: secret("T45_RUNNER_TOKEN"),
    openCodeKey: secret("OPENCODE_API_KEY"),
  }),
);
