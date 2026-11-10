import { type Agent, Refused } from "@t45/contracts/models/Agent";
import { NotFound } from "@t45/contracts/resources/errors";
import { Agents, AgentSummary } from "@t45/contracts/resources/Agents";
import { Authorization } from "@t45/contracts/Authorization";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { HttpClient, HttpClientResponse } from "effect/http";

import { AgentRepository } from "./AgentRepository.ts";
import { SkillRepository } from "./SkillRepository.ts";

/** OpenCode Go's models, OpenAI-style (`{ data: [{ id }] }`); listing them needs no key. */
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";

const decodeModels = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
);

export const layer = Agents.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const agents = yield* AgentRepository;
    const skills = yield* SkillRepository;
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;

    const find = (agentId: string) =>
      agents.get(agentId).pipe(
        Effect.filterOrElse(
          (agent) => agent !== null,
          () => new NotFound(),
        ),
      );
    const models = yield* httpClient.get(MODELS_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeModels),
      Effect.map(({ data }) => data.map(({ id }) => ({ slug: `opencode-go/${id}`, name: id }))),
      Effect.timeout("15 seconds"),
      Effect.cachedWithTTL("5 minutes"),
    );
    const requireOfferedModel = (model: string) =>
      models.pipe(
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
      "agents.list": () =>
        agents.list.pipe(
          Effect.map((all) =>
            all.map((agent) => Struct.pick(agent, Struct.keys(AgentSummary.fields))),
          ),
        ),
      "agents.listModels": () =>
        models.pipe(
          Effect.map((models) => ({ models, reason: null })),
          Effect.orElseSucceed(() => ({ models: [], reason: "OpenCode Go did not answer." })),
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
