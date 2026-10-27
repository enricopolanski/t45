import { type Agent, Refused } from "@t45/contracts/models/Agent";
import { NotFound } from "@t45/contracts/resources/errors";
import { Agents } from "@t45/contracts/resources/Agents";
import { Authorization } from "@t45/contracts/Authorization";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { RunnerService } from "../runner/RunnerService.ts";
import { AgentRepository } from "./AgentRepository.ts";
import { SkillRepository } from "./SkillRepository.ts";

export const layer = Agents.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const agents = yield* AgentRepository;
    const skills = yield* SkillRepository;
    const runner = yield* RunnerService;
    const crypto = yield* Crypto.Crypto;

    const find = (agentId: string) =>
      agents.get(agentId).pipe(
        Effect.filterOrElse(
          (agent) => agent !== null,
          () => new NotFound(),
        ),
      );
    const requireOfferedModel = (model: string) =>
      runner.models.pipe(
        Effect.orElseSucceed(() => []),
        Effect.flatMap((offered) =>
          offered.some((entry) => entry.slug === model)
            ? Effect.void
            : new Refused({ reason: "model_unavailable" }),
        ),
      );
    const requireSkills = (skillIds: ReadonlyArray<string>) =>
      Effect.forEach(skillIds, (skillId) =>
        skills
          .get(skillId)
          .pipe(
            Effect.flatMap((skill) =>
              skill === null ? new Refused({ reason: "skill_not_found" }) : Effect.void,
            ),
          ),
      );
    const save = (agent: Agent) => agents.save(agent).pipe(Effect.as(agent));

    return Agents.of({
      "agents.list": () => agents.list,
      "agents.listModels": () =>
        runner.models.pipe(
          Effect.map((models) => ({ models, reason: null })),
          Effect.catchTags({
            RunnerUnavailableError: (error) =>
              Effect.succeed({ models: [], reason: error.message }),
          }),
        ),
      "agents.get": ({ agentId }) => find(agentId),
      "agents.archive": ({ agentId }) =>
        Effect.gen(function* () {
          const agent = yield* find(agentId);
          if (agent.status === "archived") return agent;
          return yield* save({ ...agent, status: "archived", updatedAt: yield* DateTime.now }).pipe(
            Effect.orDie,
          );
        }),
      "agents.create": (draft) =>
        Effect.gen(function* () {
          yield* requireOfferedModel(draft.model);
          yield* requireSkills(draft.skills);
          const now = yield* DateTime.now;
          return yield* save({
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            ...draft,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
        }),
      "agents.restore": ({ agentId }) =>
        Effect.gen(function* () {
          const agent = yield* find(agentId);
          if (agent.status === "active") return agent;
          return yield* save({ ...agent, status: "active", updatedAt: yield* DateTime.now });
        }),
      "agents.update": ({ agentId, ...draft }) =>
        Effect.gen(function* () {
          const agent = yield* find(agentId);
          if (draft.model !== agent.model) yield* requireOfferedModel(draft.model);
          yield* requireSkills(draft.skills);
          return yield* save({ ...agent, ...draft, updatedAt: yield* DateTime.now });
        }),
    });
  }),
);
