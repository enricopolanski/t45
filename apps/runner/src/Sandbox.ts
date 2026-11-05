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

export interface Sandbox {
  readonly url: string;
  readonly password: Redacted.Redacted;
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, SandboxError>;
  /** Removes the sandbox and returns its disk, for a later start. */
  readonly save: Effect.Effect<Uint8Array, SandboxError>;
}

export class SandboxManager extends Context.Service<
  SandboxManager,
  {
    readonly start: (
      id: string,
      agent: RunRequest["agent"],
      disk: Uint8Array | null,
    ) => Effect.Effect<Sandbox, SandboxError, Scope.Scope>;
  }
>()("@t45/runner/Sandbox/SandboxManager") {}
