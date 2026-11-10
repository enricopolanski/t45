import {
  isSameSchedule,
  nextRunAt,
  Refused,
  type Automation,
  AutomationId,
} from "@t45/contracts/models/Automation";
import { Authorization } from "@t45/contracts/Authorization";
import { NotFound } from "@t45/contracts/resources/errors";
import { Automations } from "@t45/contracts/resources/Automations";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { canWorkSteps } from "@t45/contracts/models/Agent";
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

    const found = <A>(automation: A | null) =>
      automation === null ? Effect.fail(new NotFound()) : Effect.succeed(automation);
    const requireActiveAgent = (agentId: string) =>
      agents.get(agentId).pipe(
        Effect.filterOrFail(
          (agent) => agent !== null && agent.status === "active",
          () => new Refused({ reason: "agent_unavailable" }),
        ),
      );

    return Automations.of({
      "automations.list": () => automations.list,
      "automations.listForSteps": () =>
        Effect.gen(function* () {
          const available = new Set(
            (yield* agents.list).filter(canWorkSteps).map((agent) => agent.id),
          );
          return (yield* automations.list)
            .filter((automation) => available.has(automation.agentId))
            .map((automation) => Struct.pick(automation, ["id", "title", "prompt", "agentId"]));
        }),
      "automations.create": (settings) =>
        Effect.gen(function* () {
          yield* requireActiveAgent(settings.agentId);
          const now = yield* DateTime.now;
          const automation: Automation = {
            ...settings,
            id: AutomationId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            nextRunAt: nextRunAt(settings, now),
            lastError: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* automations.insert(automation);
          return automation;
        }),
      "automations.update": ({ id, ...settings }) =>
        Effect.gen(function* () {
          yield* requireActiveAgent(settings.agentId);
          const now = yield* DateTime.now;
          const updated = yield* automations.modify(id, (current) => {
            const shouldRestartClock =
              current.isEnabled !== settings.isEnabled ||
              !isSameSchedule(current.schedule, settings.schedule);
            return Effect.succeed({
              ...current,
              ...settings,
              nextRunAt: shouldRestartClock ? nextRunAt(settings, now) : current.nextRunAt,
              updatedAt: now,
            });
          });
          return yield* found(updated);
        }),
      "automations.setEnabled": ({ id, isEnabled }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const updated = yield* automations.modify(id, (current) =>
            Effect.succeed(
              current.isEnabled === isEnabled
                ? current
                : {
                    ...current,
                    isEnabled,
                    nextRunAt: nextRunAt({ isEnabled, schedule: current.schedule }, now),
                    updatedAt: now,
                  },
            ),
          );
          return yield* found(updated);
        }),
      "automations.runNow": ({ id }) => service.runNow(id).pipe(Effect.asVoid),
    });
  }),
);
