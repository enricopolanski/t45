/**
 * A `Skill` is a reusable package of know-how, instructions plus any supporting material, written once and handed to whichever agents need it, so they do a kind of task the same way every time.
 */
import { Skill as OpenCodeSkill } from "@opencode/schema/skill";
import * as Schema from "effect/Schema";

import { FilesByPath, StringId, TrimmedNonEmptyString } from "./primitives.ts";

/** Also the skill's folder name in the VM: lowercase words joined by hyphens. */
export const Name = OpenCodeSkill.Name.check(
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);

/** What agents read to decide when to use the skill. */
const Description = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

export class Skill extends Schema.Opaque<Skill>()(
  Schema.Struct({
    id: StringId,
    name: Name,
    description: Description,
    /** SKILL.md's body, below the frontmatter the runner writes from the name and description. */
    content: OpenCodeSkill.Info.fields.content,
    /** The supporting files beside SKILL.md, by path. */
    files: FilesByPath(["SKILL.md"]),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

const REFUSALS = ["name_taken"] as const;
export type Refusal = (typeof REFUSALS)[number];

export class Refused extends Schema.TaggedError<Refused>()("SkillRefused", {
  reason: Schema.Literals(REFUSALS),
}) {
  override get message(): string {
    switch (this.reason) {
      case "name_taken":
        return "Another skill already has that name.";
    }
  }
}
