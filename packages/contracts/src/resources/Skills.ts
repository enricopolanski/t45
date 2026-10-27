import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Refused, Skill } from "../models/Skill.ts";
import { AdminOnly } from "../Authorization.ts";
import { NotFound } from "./errors.ts";
import { StringId } from "../models/primitives.ts";

/** Creates a skill, or replaces all of one. */
class SaveSkillRequest extends Schema.Opaque<SaveSkillRequest>()(
  Schema.Struct(Struct.pick(Skill.fields, ["name", "description", "content", "files"])),
) {}

export const Skills = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(Skill) }),
  Rpc.make("create", {
    payload: SaveSkillRequest,
    success: Skill,
    error: Refused,
  }),
  Rpc.make("delete", {
    payload: { skillId: StringId },
    error: NotFound,
  }),
  Rpc.make("update", {
    payload: { skillId: StringId, ...SaveSkillRequest.fields },
    success: Skill,
    error: Schema.Union([Refused, NotFound]),
  }),
)
  .prefix("skills.")
  .middleware(AdminOnly);
