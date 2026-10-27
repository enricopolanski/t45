import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { Agent, AgentModel } from "../models/Agent.ts";
import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { Name as SkillName, Skill } from "../models/Skill.ts";

/** VM operations between T45 and the runner. The server owns the association to chats. */

export const SkillSnapshot = Schema.Struct(
  Struct.pick(Skill.fields, ["name", "description", "content", "files"]),
);
export type SkillSnapshot = typeof SkillSnapshot.Type;

export class RunConfig extends Schema.Opaque<RunConfig>()(
  Schema.Struct({
    agent: Schema.Struct({
      ...Struct.pick(Agent.fields, ["instructions", "files", "mcpServers", "permissions"]),
      skills: Schema.Record(Schema.String, SkillSnapshot).check(
        Schema.isPropertyNames(SkillName),
        Schema.makeFilter(
          (skills) => Object.entries(skills).every(([name, skill]) => name === skill.name),
          { expected: "skill keys matching their names" },
        ),
      ),
    }),
  }),
) {}

/** A file's bytes, sent as the body as they are. */
const RunnerFileContent = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array());

/** An opaque VM identifier; its association to chats stays on T45. */
const VmId = TrimmedNonEmptyString.check(Schema.isPattern(/^[^/?#\s]{1,200}$/u));

const RunnerVmState = Schema.Literals(["starting", "running", "stopped"]);

/** The VMs the runner holds, and whether it can run sandboxes now; when it can't, the reason. */
export class RunnerInventory extends Schema.Opaque<RunnerInventory>()(
  Schema.Struct({
    isAvailable: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    vms: Schema.Array(
      Schema.Struct({
        vmId: VmId,
        state: RunnerVmState,
        connections: Schema.Int,
        lastActiveAt: Schema.DateTimeUtcFromString,
      }),
    ),
  }),
) {}

export class RunnerUnauthorizedError extends Schema.TaggedError<RunnerUnauthorizedError>()(
  "RunnerUnauthorizedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The runner refused the caller's token.";
  }
}

/** The runner refuses a VM or file request, with a reason a person can act on. */
export class RunnerRefusedError extends Schema.TaggedError<RunnerRefusedError>()(
  "RunnerRefusedError",
  { reason: Schema.String },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Every runner request carries T45's bearer token. */
export class RunnerAuth extends HttpApiMiddleware.Service<RunnerAuth>()("RunnerAuth", {
  error: RunnerUnauthorizedError,
}) {}

class RunnerApiGroup extends HttpApiGroup.make("runner")
  .add(HttpApiEndpoint.get("inventory", "/inventory", { success: RunnerInventory }))
  .add(
    /** The models the runner signs in to, which agents choose from. */
    HttpApiEndpoint.get("models", "/models", {
      success: Schema.Struct({ models: Schema.Array(AgentModel) }),
    }),
  )
  .add(
    HttpApiEndpoint.put("ensureChat", "/chats/:vmId", {
      params: { vmId: VmId },
      payload: RunConfig,
      /** Which boot of the VM runs; T45 decides what a new boot needs restored. */
      success: Schema.Struct({ bootId: TrimmedNonEmptyString }),
      error: RunnerRefusedError,
    }),
  )
  .add(
    /**
     * The running chat VM's `/work` as a gzipped tarball, less what T45 writes at every start
     * (attachments, AGENTS.md, opencode.json, skills), the step tools' snapshots and rebuildable
     * caches.
     */
    HttpApiEndpoint.get("getChatWorkspace", "/chats/:vmId/workspace", {
      params: { vmId: VmId },
      success: RunnerFileContent,
      error: RunnerRefusedError,
    }),
  )
  .add(
    /** Unpacks a workspace tarball from `getChatWorkspace` into the running chat VM's `/work`. */
    HttpApiEndpoint.put("putChatWorkspace", "/chats/:vmId/workspace", {
      params: { vmId: VmId },
      payload: RunnerFileContent,
      error: RunnerRefusedError,
    }),
  )
  .add(
    HttpApiEndpoint.put("putChatFile", "/chats/:vmId/files", {
      params: { vmId: VmId },
      /** One file under `attachments/`. */
      query: {
        path: TrimmedNonEmptyString,
      },
      payload: RunnerFileContent,
      error: RunnerRefusedError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeChat", "/chats/:vmId", {
      params: { vmId: VmId },
    }),
  )
  .middleware(RunnerAuth) {}

/** The runner's API, which only T45 calls. */
export class RunnerHttpApi extends HttpApi.make("runner").add(RunnerApiGroup) {}
