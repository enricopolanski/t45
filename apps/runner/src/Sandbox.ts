import type { RunRequest } from "@t45/contracts/resources/Runner";
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

/** A running VM: where the runner reaches its OpenCode server. */
export interface Vm {
  readonly url: string;
  readonly password: Redacted.Redacted;
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, SandboxError>;
  /** Removes the VM and returns its disk, for a later start. */
  readonly save: Effect.Effect<Uint8Array, SandboxError>;
}

/** Every start is a new VM, removed when its scope closes. */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Replaces any VM left under `id`, boots it on `disk` or a new one, and waits for OpenCode and the agent's MCP servers. */
    readonly start: (
      id: string,
      agent: RunRequest["agent"],
      disk: Uint8Array | null,
    ) => Effect.Effect<Vm, SandboxError, Scope.Scope>;
  }
>()("@t45/runner/Sandbox") {}
