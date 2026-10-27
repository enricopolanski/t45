import {
  isSameSchedule,
  nextRunAt,
  Refused,
  type Schedule,
  type Automation,
  AutomationId,
} from "@t45/contracts/models/Automation";
import { Authorization } from "@t45/contracts/Authorization";
import { NotFound } from "@t45/contracts/resources/errors";
import { Automations } from "@t45/contracts/resources/Automations";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";

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
    const newToken = crypto.randomBytes(32).pipe(Effect.map(Base64Url.encode), Effect.orDie);
    const tokenFor = (schedule: Schedule) =>
      schedule.type === "webhook" ? newToken : Effect.succeed(null);

    return Automations.of({
      "automations.list": () => automations.list,
      "automations.create": (settings) =>
        Effect.gen(function* () {
          yield* requireActiveAgent(settings.agentId);
          const now = yield* DateTime.now;
          const automation: Automation = {
            ...settings,
            id: AutomationId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            webhookToken: yield* tokenFor(settings.schedule),
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
          const updated = yield* automations.modify(id, (current) =>
            Effect.gen(function* () {
              const shouldRestartClock =
                current.isEnabled !== settings.isEnabled ||
                !isSameSchedule(current.schedule, settings.schedule);
              return {
                ...current,
                ...settings,
                webhookToken:
                  settings.schedule.type === "webhook"
                    ? (current.webhookToken ?? (yield* newToken))
                    : null,
                nextRunAt: shouldRestartClock ? nextRunAt(settings, now) : current.nextRunAt,
                updatedAt: now,
              };
            }),
          );
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
      "automations.runNow": ({ id }) =>
        service.runNow(id).pipe(Effect.map((chatId) => ({ chatId }))),
      "automations.rotateToken": ({ id }) =>
        automations
          .modify(
            id,
            Effect.fnUntraced(function* (automation) {
              if (automation.schedule.type !== "webhook")
                return yield* new Refused({ reason: "not_a_webhook" });
              return {
                ...automation,
                webhookToken: yield* newToken,
                updatedAt: yield* DateTime.now,
              };
            }),
          )
          .pipe(Effect.flatMap(found)),
    });
  }),
);
