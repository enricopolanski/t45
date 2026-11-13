import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Agent } from "../models/Agent.ts";
import { Capability } from "../models/Capability.ts";

/** Deployment-supplied records, independent of any server implementation. */
export const BuiltIns = Schema.Struct({
  capabilities: Schema.Array(Capability),
  agents: Schema.Array(
    Schema.Struct(
      Struct.pick(Agent.fields, [
        "id",
        "name",
        "instructions",
        "model",
        "files",
        "skills",
        "capabilities",
        "permissions",
        "isConversational",
      ]),
    ),
  ),
});
