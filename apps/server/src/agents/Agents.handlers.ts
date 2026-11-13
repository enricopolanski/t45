import { type Agent, canManage, canUse, isBuiltIn, Refused } from "@t45/contracts/models/Agent";
import { NotFound } from "@t45/contracts/resources/errors";
import { Agents, AgentSummary } from "@t45/contracts/resources/Agents";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { HttpClient, HttpClientResponse } from "effect/http";

import { AutomationRepository } from "../automations/AutomationRepository.ts";
import { CommandLogRepository } from "../persistence/CommandLogRepository.ts";
import { WorkflowRepository } from "../workflows/WorkflowRepository.ts";
import { AgentRepository } from "./AgentRepository.ts";
import { SkillRepository } from "./SkillRepository.ts";
import { CapabilityRepository } from "../capabilities/CapabilityRepository.ts";

/** OpenCode Go's models, OpenAI-style (`{ data: [{ id }] }`); listing them needs no key. */
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";

const decodeModels = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
);

export const layer = Agents.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const agents = yield* AgentRepository;
    const skills = yield* SkillRepository;
    const capabilities = yield* CapabilityRepository;
    const automations = yield* AutomationRepository;
    const workflows = yield* WorkflowRepository;
    const commandLog = yield* CommandLogRepository;
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;

    /** An agent the member doesn't manage is as good as missing. */
    const find = Effect.fnUntraced(function* (agentId: string) {
      const member = yield* CurrentUser;
      const agent = yield* agents.get(agentId);
      if (agent === null || !canManage(agent, member)) return yield* new NotFound();
      return agent;
    });
    const findCustom = (agentId: string) =>
      find(agentId).pipe(
        Effect.filterOrFail(
          (agent) => !isBuiltIn(agent),
          () => new Refused({ reason: "built_in" }),
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
    const requireCapabilities = (capabilityIds: ReadonlyArray<string>) =>
      Effect.forEach(capabilityIds, (capabilityId) =>
        capabilities
          .get(capabilityId)
          .pipe(
            Effect.flatMap((capability) =>
              capability === null ? new Refused({ reason: "capability_not_found" }) : Effect.void,
            ),
          ),
      );

    return Agents.of({
      "agents.list": () =>
        Effect.gen(function* () {
          const member = yield* CurrentUser;
          return (yield* agents.list)
            .filter((agent) => canUse(agent, member.userId) || canManage(agent, member))
            .map((agent) => Struct.pick(agent, Struct.keys(AgentSummary.fields)));
        }),
      "agents.listModels": () =>
        models.pipe(
          Effect.map((models) => ({ models, reason: null })),
          Effect.orElseSucceed(() => ({ models: [], reason: "OpenCode Go did not answer." })),
        ),
      "agents.get": ({ agentId }) => find(agentId),
      "agents.archive": ({ agentId }) =>
        Effect.gen(function* () {
          const agent = yield* findCustom(agentId);
          if (agent.status === "archived") return agent;
          // An agent that a step of some workflow version reaches, through an automation that
          // isn't archived, stays active. Checked in the archive's own transaction.
          const archived = yield* agents.modify(
            agent.id,
            Effect.fnUntraced(function* (current) {
              for (const automation of yield* automations.listForAgent(current.id)) {
                if ((yield* workflows.listAttaching(automation.id)).length > 0)
                  return yield* new Refused({ reason: "attached_to_workflow" });
              }
              return { ...current, status: "archived" as const, updatedAt: yield* DateTime.now };
            }),
          );
          return archived ?? (yield* new NotFound());
        }),
      "agents.create": (draft) =>
        Effect.gen(function* () {
          yield* requireOfferedModel(draft.model);
          yield* requireSkills(draft.skills);
          yield* requireCapabilities(draft.capabilities);
          const now = yield* DateTime.now;
          return yield* save({
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            ...draft,
            creatorUserId: (yield* CurrentUser).userId,
            isPublished: false,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
        }),
      "agents.publish": ({ agentId }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentUser;
          const agent = yield* agents.get(agentId);
          if (agent === null || agent.creatorUserId !== userId) return yield* new NotFound();
          // The log entry commits with the publication it records.
          const published = yield* agents
            .modify(
              agent.id,
              Effect.fnUntraced(function* (current) {
                if (current.isPublished) return current;
                const now = yield* DateTime.now;
                yield* commandLog.append({
                  command: "agents.publish",
                  userId,
                  agentId: null,
                  chatId: null,
                  details: { agentId: current.id },
                  createdAt: now,
                });
                return { ...current, isPublished: true, updatedAt: now };
              }),
            )
            .pipe(Effect.orDie);
          return published ?? (yield* new NotFound());
        }),
      "agents.update": ({ agentId, ...draft }) =>
        Effect.gen(function* () {
          const agent = yield* findCustom(agentId);
          if (draft.model !== agent.model) yield* requireOfferedModel(draft.model);
          yield* requireSkills(draft.skills);
          yield* requireCapabilities(draft.capabilities);
          return yield* save({ ...agent, ...draft, updatedAt: yield* DateTime.now });
        }),
    });
  }),
);
