/*
 * The runner's settings, from its environment, all required:
 *
 *   T45_RUNNER_HOST, T45_RUNNER_PORT   where it listens
 *   T45_RUNNER_TOKEN                   the bearer token T45 sends
 *   T45_RUNNER_IMAGE                   the agent image
 *   OPENCODE_API_KEY                   the OpenCode Go key agents' models run on
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class RunnerConfig extends Context.Service<
  RunnerConfig,
  {
    readonly host: string;
    readonly port: number;
    readonly token: Redacted.Redacted;
    readonly image: string;
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
    image: Config.schema(Schema.NonEmptyString, "T45_RUNNER_IMAGE"),
    openCodeKey: secret("OPENCODE_API_KEY"),
  }),
);
