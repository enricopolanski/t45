import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

const secret = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const host = Config.schema(Schema.NonEmptyString, "T45_RUNNER_HOST");
export const port = Config.Port("T45_RUNNER_PORT");
export const token = secret("T45_RUNNER_TOKEN");
export const openCodeKey = secret("OPENCODE_API_KEY");
