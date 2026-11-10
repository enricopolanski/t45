import type { ChatId, Refused as ChatRefused } from "@t45/contracts/models/Chat";
import {
  isMissed,
  nextRunAt,
  type Automation,
  type AutomationId,
} from "@t45/contracts/models/Automation";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomationRepository from "./AutomationRepository.ts";
import { ChatService } from "../chats/ChatService.ts";

const refusalOf = (run: Result.Result<ChatId, ChatRefused>) =>
  Result.isFailure(run) ? run.failure.message : null;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const automations = yield* AutomationRepository.AutomationRepository;
  const chats = yield* ChatService;
  const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));

  const logFailure = (message: string, annotations: Record<string, unknown> = {}) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning(message, { ...annotations, cause }),
    );

  const postRun = (automation: Automation) =>
    chats
      .startAutomation({ type: "automation", automationId: automation.id }, automation.agentId, {
        title: automation.title,
        input: { text: automation.prompt, attachments: [] },
      })
      .pipe(Effect.catchTags({ NotFound: Effect.die }), Effect.result);

  const runDue = (id: AutomationId) =>
    automations.modify(
      id,
      Effect.fnUntraced(function* (automation) {
        const now = yield* DateTime.now;
        if (
          !automation.isEnabled ||
          automation.nextRunAt === null ||
          DateTime.isGreaterThan(automation.nextRunAt, now)
        )
          return automation;
        const missed = isMissed(automation.schedule, automation.nextRunAt, now);
        if (missed) yield* Effect.logInfo("Skipping missed automation run", { automationId: id });
        const lastError = missed ? automation.lastError : refusalOf(yield* postRun(automation));
        return { ...automation, nextRunAt: nextRunAt(automation, now), lastError };
      }),
    );

  const pass = DateTime.now.pipe(
    Effect.flatMap(automations.due),
    Effect.flatMap((ids) =>
      Effect.forEach(
        ids,
        (id) => runDue(id).pipe(logFailure("Automation run failed", { automationId: id })),
        { discard: true },
      ),
    ),
    logFailure("Automation pass failed"),
  );
  // The next pass is spaced from the end of the last one, so passes never overlap.
  yield* Effect.forkScoped(pass.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  return {
    runNow: Effect.fnUntraced(function* (id: AutomationId) {
      const run = yield* transaction(
        Effect.gen(function* () {
          const automation = yield* automations.get(id);
          if (automation === null) return yield* new NotFound();
          const posted = yield* postRun(automation);
          yield* automations.setLastError(automation.id, refusalOf(posted));
          return posted;
        }),
      );
      return yield* Effect.fromResult(run);
    }),
  };
});

export class AutomationService extends Context.Service<
  AutomationService,
  Effect.Success<typeof make>
>()("t45/automations/AutomationService") {}

export const layer = Layer.effect(AutomationService, make).pipe(
  Layer.provideMerge(AutomationRepository.layer),
);
