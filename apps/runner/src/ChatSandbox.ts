/*
 * What confines a chat: a VM of its own. A VM keeps nothing, so every start is a new VM and
 * letting it go removes it. The chat table only knows this port, so tests run it with a fake and
 * production with microsandbox.
 */
import type { RunConfig, RunnerInventory } from "@t45/contracts/resources/RunnerVms";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The sandbox's ${this.operation} failed.`;
  }
}

/** One boot of a VM: its OpenCode server as the runner reaches it on the host. */
export interface ChatServer {
  /** Which boot this is; every start makes a new one. */
  readonly bootId: string;
  readonly url: string;
  readonly password: Redacted.Redacted;
}

export class ChatSandbox extends Context.Service<
  ChatSandbox,
  {
    /** Whether VMs can run now, and why not. */
    readonly health: Effect.Effect<Pick<RunnerInventory, "isAvailable" | "reason">>;
    /** Starts a new VM from `chat`, replacing any left of it, and its OpenCode server. */
    readonly start: (input: {
      readonly chatId: string;
      readonly chat: RunConfig;
    }) => Effect.Effect<ChatServer, SandboxError>;
    /** Writes `content` at `path` under the running VM's /work. */
    readonly write: (input: {
      readonly chatId: string;
      readonly path: string;
      readonly content: Uint8Array;
    }) => Effect.Effect<void, SandboxError>;
    /**
     * The running VM's /work as a gzipped tarball, less what every start writes, the step tools'
     * snapshots and rebuildable caches.
     */
    readonly packWorkspace: (chatId: string) => Effect.Effect<Uint8Array, SandboxError>;
    /** Unpacks a tarball from `packWorkspace` into the running VM's /work, keeping files there. */
    readonly unpackWorkspace: (input: {
      readonly chatId: string;
      readonly content: Uint8Array;
    }) => Effect.Effect<void, SandboxError>;
    /**
     * Whether a boot's OpenCode still answers: its VM can stop on its own, as by crashing, and
     * OpenCode can die or hang in a VM that runs.
     */
    readonly serving: (server: ChatServer) => Effect.Effect<boolean>;
    /** Stops the VM and deletes it with its disk. */
    readonly remove: (chatId: string) => Effect.Effect<void, SandboxError>;
    /**
     * Clears what an earlier process of this runner left: its VMs are removed.
     */
    readonly sweep: Effect.Effect<void, SandboxError>;
  }
>()("@t45/runner/ChatSandbox") {}
