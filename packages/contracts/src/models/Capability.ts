import { Schema } from "effect";
import { FilesByPath, StringId, TrimmedNonEmptyString } from "./primitives.ts";
import { ConfigMCP } from "@opencode/schema/config/mcp";

export const Capability = Schema.Struct({
  id: StringId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  /** Execution context needed by this capability; its bindings use {{key}} placeholders. */
  requiredContext: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  files: Schema.optionalKey(FilesByPath([])),
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server))),
});
export type Capability = typeof Capability.Type;

/** Managed capability files live outside the agent's writable /work configuration. */
export const CAPABILITIES_DIR = "/opt/t45";
