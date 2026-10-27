import type { ChatId, Refused as ChatRefused } from "@t45/contracts/models/Chat";
import {
  isMissed,
  nextRunAt,
  Refused as AutomationRefused,
  Automation,
  AutomationId,
} from "@t45/contracts/models/Automation";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import {
  constantTimeEquals,
  renderPrompt,
  verifySignature,
  type WebhookRequest,
} from "./webhook.ts";
import { TaskService } from "../tasks/TaskService.ts";

/** Requests per hook per minute, counted before the enabled and signature checks. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

export interface Delivery extends WebhookRequest {
  readonly automationId: string;
  readonly token: string;
  readonly body: Uint8Array;
}

const decodeAutomationId = Schema.decodeUnknownOption(AutomationId);

const webhookRefusal = (refused: ChatRefused) => {
  switch (refused.reason) {
    case "empty_input":
      return "prompt_empty" as const;
    case "input_too_long":
      return "prompt_too_long" as const;
    case "agent_unavailable":
      return "agent_unavailable" as const;
    default:
      return null;
  }
};

const refusalOf = (run: Result.Result<ChatId, ChatRefused>) =>
  Result.isFailure(run) ? run.failure.message : null;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const automations = yield* AutomationRepository.AutomationRepository;
  const tasks = yield* TaskService;
  const rateWindows = yield* Ref.make<
    ReadonlyMap<AutomationId, { readonly start: number; readonly count: number }>
  >(new Map());
  const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));

  const logFailure = (message: string, annotations: Record<string, unknown> = {}) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning(message, { ...annotations, cause }),
    );

  const postRun = (automation: Automation, text: string) =>
    tasks
      .start({ type: "automation", automationId: automation.id }, automation.agentId, {
        title: automation.title,
        input: { text, attachments: [] },
      })
      .pipe(Effect.result);

  const recordRun = (automation: Automation, text: string) =>
    Effect.gen(function* () {
      const run = yield* postRun(automation, text);
      yield* automations.setLastError(automation.id, refusalOf(run));
      return run;
    });

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
        const lastError = missed
          ? automation.lastError
          : refusalOf(yield* postRun(automation, automation.prompt));
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
  // Parked until the server is ready. The next pass is spaced from the end
  // of the last one, so passes never overlap.
  yield* forkParked(pass.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  /**
   * A one-minute window counting every request with a valid token, including
   * ones the enabled and signature checks later refuse.
   */
  const takeRateSlot = (id: AutomationId, nowMs: number) =>
    Ref.modify(rateWindows, (windows) => {
      const current = new Map([...windows].filter(([, window]) => nowMs - window.start < 60_000));
      const window = current.get(id) ?? { start: nowMs, count: 0 };
      if (window.count >= WEBHOOK_RATE_LIMIT_PER_MINUTE) return [false, current] as const;
      current.set(id, { start: window.start, count: window.count + 1 });
      return [true, current] as const;
    });

  const deliver = Effect.fnUntraced(function* (delivery: Delivery) {
    const automationId = decodeAutomationId(delivery.automationId);
    if (Option.isNone(automationId)) return { _tag: "not_found" } as const;
    const automation = yield* automations.get(automationId.value);
    // A wrong token is indistinguishable from an unknown hook, so the URL
    // does not reveal which hooks exist.
    if (
      automation === null ||
      automation.schedule.type !== "webhook" ||
      automation.webhookToken === null ||
      !constantTimeEquals(delivery.token, automation.webhookToken)
    ) {
      return { _tag: "not_found" } as const;
    }
    const now = yield* DateTime.now;
    if (!(yield* takeRateSlot(automation.id, DateTime.toEpochMillis(now)))) {
      return { _tag: "rate_limited" } as const;
    }
    if (!automation.isEnabled) return { _tag: "disabled" } as const;
    const signature = automation.schedule.signature;
    if (signature !== null && !verifySignature(signature, delivery.headers, delivery.body)) {
      return { _tag: "bad_signature" } as const;
    }
    const run = yield* recordRun(automation, renderPrompt(automation.prompt, delivery));
    if (Result.isSuccess(run)) return { _tag: "accepted", chatId: run.success } as const;
    const reason = webhookRefusal(run.failure);
    if (reason === null) return yield* Effect.die(run.failure);
    return { _tag: "refused", reason } as const;
  }, transaction);

  return {
    runNow: Effect.fnUntraced(function* (id: AutomationId) {
      const run = yield* transaction(
        Effect.gen(function* () {
          const automation = yield* automations.get(id);
          if (automation === null) return yield* new NotFound();
          // There is no request to render the prompt from.
          if (automation.schedule.type === "webhook") {
            return yield* new AutomationRefused({ reason: "runs_on_request" });
          }
          return yield* recordRun(automation, automation.prompt);
        }),
      );
      return yield* Effect.fromResult(run);
    }),
    deliver,
  };
});

export class AutomationService extends Context.Service<
  AutomationService,
  Effect.Success<typeof make>
>()("t45/automations/AutomationService") {}

export const layer = Layer.effect(AutomationService, make).pipe(
  Layer.provideMerge(AutomationRepository.layer),
);
