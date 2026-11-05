import type { Execution } from "@t45/contracts/resources/Runner";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The sandbox's ${this.operation} failed.`;
  }
}

/** A running VM: where the runner reaches its OpenCode server, and its /work. */
export interface Vm {
  readonly url: string;
  readonly password: Redacted.Redacted;
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, SandboxError>;
  /** A gzipped tarball, less what every start writes, .t45 and rebuildable caches. */
  readonly pack: Effect.Effect<Uint8Array, SandboxError>;
  /** Keeps what this start wrote over the tarball's copy. */
  readonly unpack: (tarball: Uint8Array) => Effect.Effect<void, SandboxError>;
}

/** A VM keeps nothing: every start is a new one, removed with its disk when its scope closes. */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Replaces any VM left under `id`, and waits for OpenCode and the agent's MCP servers. */
    readonly start: (
      id: string,
      agent: Execution["agent"],
    ) => Effect.Effect<Vm, SandboxError, Scope.Scope>;
  }
>()("@t45/runner/Sandbox") {}
