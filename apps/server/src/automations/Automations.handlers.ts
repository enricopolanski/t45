import {
  canRun,
  nextRunAt,
  Refused,
  type Automation,
  AutomationId,
  type ScheduleTrigger,
  ScheduleTriggerId,
} from "@t45/contracts/models/Automation";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { NotFound } from "@t45/contracts/resources/errors";
import { Automations } from "@t45/contracts/resources/Automations";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { type Agent, canUse, canWorkSteps } from "@t45/contracts/models/Agent";
import * as Struct from "effect/Struct";
import { AgentRepository } from "../agents/AgentRepository.ts";
import { AutomationRepository } from "./AutomationRepository.ts";
import { AutomationService } from "./AutomationService.ts";

export const layer = Automations.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const automations = yield* AutomationRepository;
    const service = yield* AutomationService;
    const agents = yield* AgentRepository;

    const found = <A>(value: A | null) =>
      value === null ? Effect.fail(new NotFound()) : Effect.succeed(value);
    const requireActiveAgent = (agentId: string) =>
      agents.get(agentId).pipe(
        Effect.filterOrFail(
          (agent) => agent !== null && agent.status === "active",
          () => new Refused({ reason: "agent_unavailable" }),
        ),
      );
    /** Admins get no exception: the agent they pick must be theirs to use. */
    const requireUse = (agent: Agent | null) =>
      Effect.flatMap(CurrentUser, ({ userId }) =>
        agent === null || canUse(agent, userId)
          ? Effect.void
          : Effect.fail(new Refused({ reason: "agent_unavailable" })),
      );
    /** Finds the automation the caller may run now, by hand or by enabling a schedule of theirs. */
    const findRunnable = Effect.fnUntraced(function* (id: AutomationId) {
      const automation = yield* found(yield* automations.get(id));
      if (!canRun(yield* CurrentUser, yield* agents.get(automation.agentId)))
        return yield* new Refused({ reason: "agent_unavailable" });
      return automation;
    });

    return Automations.of({
      "automations.list": () => automations.list,
      "automations.listForSteps": () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentUser;
          const available = new Set(
            (yield* agents.list)
              .filter((agent) => canWorkSteps(agent) && canUse(agent, userId))
              .map((agent) => agent.id),
          );
          return (yield* automations.list)
            .filter((automation) => available.has(automation.agentId))
            .map((automation) => Struct.pick(automation, ["id", "title", "prompt", "agentId"]));
        }),
      "automations.create": (settings) =>
        Effect.gen(function* () {
          yield* requireUse(yield* requireActiveAgent(settings.agentId));
          const now = yield* DateTime.now;
          const automation: Automation = {
            ...settings,
            id: AutomationId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            createdAt: now,
            updatedAt: now,
          };
          yield* automations.save(automation);
          return automation;
        }),
      "automations.update": ({ id, ...settings }) =>
        Effect.gen(function* () {
          const agent = yield* requireActiveAgent(settings.agentId);
          const saved = yield* found(yield* automations.get(id));
          if (settings.agentId !== saved.agentId) yield* requireUse(agent);
          const updated = { ...saved, ...settings, updatedAt: yield* DateTime.now };
          yield* automations.save(updated);
          return updated;
        }),
      "automations.runNow": ({ id }) =>
        Effect.gen(function* () {
          const automation = yield* findRunnable(id);
          yield* service.runNow(automation, (yield* CurrentUser).userId);
        }),
      "automations.createScheduleTrigger": ({ automationId, schedule }) =>
        Effect.gen(function* () {
          yield* findRunnable(automationId);
          const now = yield* DateTime.now;
          const trigger: ScheduleTrigger = {
            id: ScheduleTriggerId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            automationId,
            creatorUserId: (yield* CurrentUser).userId,
            schedule,
            status: "enabled",
            nextRunAt: nextRunAt(schedule, now),
            lastError: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* automations.triggers.insert(trigger);
          return trigger;
        }),
      "automations.setScheduleTriggerEnabled": ({ id, isEnabled }) =>
        automations.triggers
          .modify(
            id,
            Effect.fnUntraced(function* (trigger) {
              if (isEnabled === (trigger.status === "enabled")) return trigger;
              if (isEnabled) {
                if (trigger.creatorUserId !== (yield* CurrentUser).userId)
                  return yield* new Refused({ reason: "not_creator" });
                yield* findRunnable(trigger.automationId);
              }
              const now = yield* DateTime.now;
              const status: ScheduleTrigger["status"] = isEnabled ? "enabled" : "disabled";
              return {
                ...trigger,
                status,
                nextRunAt: isEnabled ? nextRunAt(trigger.schedule, now) : null,
                updatedAt: now,
              };
            }),
          )
          .pipe(Effect.flatMap(found)),
      "automations.archiveScheduleTrigger": ({ id }) =>
        automations.triggers
          .modify(id, (trigger) =>
            Effect.map(DateTime.now, (now): ScheduleTrigger => ({
              ...trigger,
              status: "archived",
              nextRunAt: null,
              updatedAt: now,
            })),
          )
          .pipe(Effect.flatMap(found), Effect.asVoid),
    });
  }),
);
