import { type Skill } from "@t45/contracts/models/Skill";
import { Authorization } from "@t45/contracts/Authorization";
import { NotFound } from "@t45/contracts/resources/errors";
import { Skills } from "@t45/contracts/resources/Skills";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { SkillRepository } from "./SkillRepository.ts";

export const layer = Skills.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const skills = yield* SkillRepository;
    const crypto = yield* Crypto.Crypto;

    const find = (skillId: string) =>
      skills.get(skillId).pipe(
        Effect.filterOrElse(
          (skill) => skill !== null,
          () => new NotFound(),
        ),
      );
    const save = (skill: Skill) => skills.save(skill).pipe(Effect.as(skill));

    return Skills.of({
      "skills.list": () => skills.list,
      "skills.create": (draft) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* save({
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            ...draft,
            createdAt: now,
            updatedAt: now,
          });
        }),
      "skills.delete": ({ skillId }) =>
        skills.remove(skillId).pipe(
          Effect.filterOrFail(
            (removed) => removed,
            () => new NotFound(),
          ),
          Effect.asVoid,
        ),
      "skills.update": ({ skillId, ...draft }) =>
        Effect.gen(function* () {
          const skill = yield* find(skillId);
          return yield* save({ ...skill, ...draft, updatedAt: yield* DateTime.now });
        }),
    });
  }),
);
