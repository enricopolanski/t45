import {
  canRun,
  isMissed,
  nextRunAt,
  Refused,
  type Automation,
  type ScheduleTrigger,
  type ScheduleTriggerId,
} from "@t45/contracts/models/Automation";
import type { Trigger } from "@t45/contracts/models/ChatOrigin";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import { AgentRepository } from "../agents/AgentRepository.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import { ChatService } from "../chats/ChatService.ts";
import { UserRepository } from "../org/UserRepository.ts";

const make = Effect.gen(function* () {
  const automations = yield* AutomationRepository.AutomationRepository;
  const agents = yield* AgentRepository;
  const users = yield* UserRepository;
  const chats = yield* ChatService;

  const logFailure = (message: string, annotations: Record<string, unknown> = {}) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning(message, { ...annotations, cause }),
    );

  const run = (automation: Automation, trigger: Trigger) =>
    chats
      .startAutomation(trigger, automation.agentId, {
        title: automation.title,
        input: { text: automation.prompt, attachments: [] },
      })
      .pipe(Effect.catchTags({ NotFound: Effect.die }));

  /** Runs the schedule's automation as its creator; answers why the run was refused. */
  const runScheduled = Effect.fnUntraced(function* (trigger: ScheduleTrigger) {
    const automation = yield* automations
      .get(trigger.automationId)
      .pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);
    const creator = yield* users
      .get(trigger.creatorUserId)
      .pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);
    if (!canRun({ ...creator, userId: creator.id }, yield* agents.get(automation.agentId)))
      return new Refused({ reason: "creator_cannot_run" }).message;
    const started = yield* run(automation, {
      type: "schedule",
      automationId: automation.id,
      scheduleTriggerId: trigger.id,
      effectiveUserId: creator.id,
    }).pipe(Effect.result);
    return Result.isFailure(started) ? started.failure.message : null;
  });

  const runDue = (id: ScheduleTriggerId) =>
    automations.triggers.modify(
      id,
      Effect.fnUntraced(function* (trigger) {
        const now = yield* DateTime.now;
        if (
          trigger.status !== "enabled" ||
          trigger.nextRunAt === null ||
          DateTime.isGreaterThan(trigger.nextRunAt, now)
        )
          return trigger;
        const missed = isMissed(trigger.schedule, trigger.nextRunAt, now);
        if (missed)
          yield* Effect.logInfo("Skipping missed scheduled run", { scheduleTriggerId: id });
        const lastError = missed ? trigger.lastError : yield* runScheduled(trigger);
        return { ...trigger, nextRunAt: nextRunAt(trigger.schedule, now), lastError };
      }),
    );

  const pass = DateTime.now.pipe(
    Effect.flatMap(automations.triggers.due),
    Effect.flatMap((ids) =>
      Effect.forEach(
        ids,
        (id) => runDue(id).pipe(logFailure("Scheduled run failed", { scheduleTriggerId: id })),
        { discard: true },
      ),
    ),
    logFailure("Schedule pass failed"),
  );
  // The next pass is spaced from the end of the last one, so passes never overlap.
  yield* Effect.forkScoped(pass.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  return {
    /** Runs the automation on `userId`'s authority. */
    runNow: (automation: Automation, userId: string) =>
      run(automation, { type: "manual", automationId: automation.id, effectiveUserId: userId }),
  };
});

export class AutomationService extends Context.Service<
  AutomationService,
  Effect.Success<typeof make>
>()("t45/automations/AutomationService") {}

export const layer = Layer.effect(AutomationService, make).pipe(
  Layer.provideMerge(AutomationRepository.layer),
);
