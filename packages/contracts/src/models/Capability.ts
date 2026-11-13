import { Schema } from "effect";
import { FilesByPath, StringId, TrimmedNonEmptyString } from "./primitives.ts";
import { ConfigMCP } from "@opencode/schema/config/mcp";

/** A runner secret's name; the runner reads its value from `CAPABILITY_SECRET_<name>`. */
const SecretName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u));

export const Capability = Schema.Struct({
  id: StringId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  /**
   * Execution context needed by this capability. Text in `mcpServers` and `environment` uses
   * `{{key}}` for a context value, `{{token}}` for the execution's tool token and `{{NAME}}` for
   * one of `secrets`; the VM gets placeholders for the token and the secrets.
   */
  requiredContext: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  files: Schema.optionalKey(FilesByPath([])),
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server))),
  /** Variables of the agent's shell, such as a command-line tool's settings. */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Hosts the VM reaches over HTTPS, whatever the agent's network. */
  hosts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Runner secrets, sent only to `hosts` and only in request headers. */
  secrets: Schema.optionalKey(Schema.Array(SecretName)),
  /** What the agent reads beside its instructions about this capability. */
  note: Schema.optionalKey(TrimmedNonEmptyString),
});
export type Capability = typeof Capability.Type;

/** Managed capability files live outside the agent's writable /work configuration. */
export const CAPABILITIES_DIR = "/opt/t45";
