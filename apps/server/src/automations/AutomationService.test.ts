import { assert, it } from "@effect/vitest";
import { type ChatId, Refused as ChatRefused } from "@t45/contracts/models/Chat";
import {
  type Automation,
  AutomationId,
  Refused,
  type ScheduleTrigger,
  ScheduleTriggerId,
} from "@t45/contracts/models/Automation";
import { AuthSessionId } from "@t45/contracts/resources/Session";

import { Authorization, CurrentActor } from "@t45/contracts/Authorization";
import { Automations } from "@t45/contracts/resources/Automations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AdminOnly } from "../auth/Authorization.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { addAgent, addUser, layer as layerChats } from "../chats/Chats.testkit.ts";
import { FakeRunner } from "../runner/FakeRunner.testkit.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import * as AutomationService from "./AutomationService.ts";
import * as AutomationsHandlers from "./Automations.handlers.ts";
import { ChatService } from "../chats/ChatService.ts";
type Run = Parameters<ChatService["Service"]["startAutomation"]>[2];

const AT = "2026-09-09T12:00:00.000Z";
const at = DateTime.makeUnsafe(AT);
const every = { type: "interval", everyMs: 60_000 } as const;
const daily = (timeOfDay: string) =>
  ({ type: "fixed_time", timeOfDay, timeZone: "UTC", weekdays: [0, 1, 2, 3, 4, 5, 6] }) as const;
const ADMIN = "user-admin";
const CLERK = "agent-clerk";
const RETIRED = "agent-retired";

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));
const runTitle = (automationId: string) => `Automation ${automationId}`;

const layerStore = AutomationRepository.layer.pipe(Layer.provideMerge(layerChats));

const seed = Effect.gen(function* () {
  // Inputs stay pending, so `runOf` reads every input a run got.
  (yield* FakeRunner).hold = true;
  yield* addUser(ADMIN, "admin");
  yield* addAgent("Clerk", { chat: false });
  yield* addAgent("Retired", { status: "archived" });
});

/** An automation with one enabled schedule of the admin's, under the same id. */
const addAutomation = (
  id: string,
  { prompt, agentId, ...fields }: Partial<Automation & ScheduleTrigger> = {},
) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    const automation: Automation = {
      id: AutomationId.make(id),
      title: `Automation ${id}`,
      prompt: prompt ?? `Run ${id}`,
      agentId: agentId ?? CLERK,
      isArchived: false,
      createdAt: at,
      updatedAt: at,
    };
    yield* automations.save(automation);
    yield* automations.triggers.insert({
      id: ScheduleTriggerId.make(id),
      automationId: automation.id,
      creatorUserId: ADMIN,
      schedule: every,
      status: "enabled",
      nextRunAt: at,
      lastError: null,
      createdAt: at,
      updatedAt: at,
      ...fields,
    });
    return automation;
  });

/** The schedule added with the automation. */
const get = (id: string) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    return yield* Effect.fromNullishOr(
      (yield* automations.list).find((automation) => automation.id === id)?.scheduleTriggers[0],
    ).pipe(Effect.orDie);
  });

const followRuns = Effect.gen(function* () {
  const changes = yield* ChatEvents;
  const chats = yield* ChatRepository;
  const runs = yield* changes
    .subscribe((change) => change.kind === "posted")
    .pipe(
      Effect.flatMap((posted) =>
        posted.pipe(
          Stream.filter((change) => change.kind !== "missed"),
          Stream.toQueue({ capacity: "unbounded" }),
        ),
      ),
    );
  return () =>
    Queue.take(runs).pipe(
      Effect.orDie,
      Effect.flatMap((change) =>
        chats
          .get(change.chatId)
          .pipe(Effect.map((chat) => ({ chatId: change.chatId, title: chat?.title ?? null }))),
      ),
    );
});

const runOf = (chatId: ChatId) =>
  Effect.gen(function* () {
    const chats = yield* ChatRepository;
    const chat = yield* chats.get(chatId).pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);
    const inputs = yield* chats.pendingInputs(chatId);
    const origin = yield* chats.origins.get(chatId);
    return {
      origin: origin?.kind === "automation" ? origin.trigger : null,
      agentId: chat.agentId,
      title: chat.title,
      inputs: inputs.map((input) => input.payload),
    };
  });

const automationsWithRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* sql<{
    readonly title: string;
  }>`SELECT c.title FROM chats c JOIN chat_origins o ON o.chat_id = c.id WHERE o.trigger IS NOT NULL ORDER BY c.title`;
  return runs.map((chat) => chat.title);
});

const layerAutomations = (afterPost: (run: Run) => Effect.Effect<void> = () => Effect.void) =>
  AutomationsHandlers.layer.pipe(
    Layer.provideMerge(AutomationService.layer),
    Layer.provide(
      Layer.effect(
        ChatService,
        Effect.gen(function* () {
          const chats = yield* ChatService;
          return ChatService.of({
            ...chats,
            startAutomation: (trigger, agentId, run) =>
              chats.startAutomation(trigger, agentId, run).pipe(Effect.tap(() => afterPost(run))),
          });
        }),
      ),
    ),
  );

const clientAs = (role: "admin" | "member") =>
  RpcTest.makeClient(Automations.middleware(Authorization)).pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(Authorization)((effect) =>
          Effect.provideService(effect, CurrentActor, {
            sessionId: AuthSessionId.make(`${role}-session`),
            userId: `user-${role}`,
            role,
            state: "active",
          }),
        ),
        AdminOnly.layer,
      ),
    ),
  );

it.effect(
  "posts a due slot to a new chat run as the schedule's creator, then advances the slot",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addAutomation("due");
      yield* addAutomation("zz-sentinel");
      yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
      const takeRun = yield* followRuns;
      yield* Layer.build(layerAutomations());

      const run = yield* takeRun();
      assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
      assert.deepEqual(yield* runOf(run.chatId), {
        origin: {
          type: "schedule",
          automationId: AutomationId.make("due"),
          scheduleTriggerId: ScheduleTriggerId.make("due"),
          effectiveUserId: ADMIN,
        },
        agentId: CLERK,
        title: "Automation due",
        inputs: [{ text: "Run due", attachments: [] }],
      });
      const trigger = yield* get("due");
      assert.equal(iso(trigger.nextRunAt), "2026-09-09T12:01:01.000Z");
      assert.isNull(trigger.lastError);
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect(
  "rolls back the post and the advance on a defect after the post, and the next pass runs the slot once",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addAutomation("due");
      yield* addAutomation("zz-sentinel");
      yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
      const takeRun = yield* followRuns;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            layerAutomations((run) =>
              run.input.text === "Run due"
                ? Effect.die("The server stopped before the slot's commit")
                : Effect.void,
            ),
          );
          assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
        }),
      );
      assert.deepEqual(yield* automationsWithRuns, [runTitle("zz-sentinel")]);
      assert.equal(iso((yield* get("due")).nextRunAt), AT);

      yield* Layer.build(layerAutomations());
      assert.deepEqual((yield* takeRun()).title, runTitle("due"));
      assert.deepEqual(yield* automationsWithRuns, [runTitle("due"), runTitle("zz-sentinel")]);
      assert.equal(iso((yield* get("due")).nextRunAt), "2026-09-09T12:01:01.000Z");
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("re-reads each due schedule, so one paused or postponed meanwhile doesn't fire", () =>
  Effect.gen(function* () {
    yield* seed;
    const automations = yield* AutomationRepository.AutomationRepository;
    for (const id of ["a-first", "b-paused", "c-postponed", "zz-sentinel"]) {
      yield* addAutomation(id);
    }
    yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
    const takeRun = yield* followRuns;
    yield* Layer.build(
      layerAutomations((run) =>
        run.input.text === "Run a-first"
          ? Effect.gen(function* () {
              yield* automations.triggers.modify(ScheduleTriggerId.make("b-paused"), (trigger) =>
                Effect.succeed({ ...trigger, status: "disabled", nextRunAt: null }),
              );
              yield* automations.triggers.modify(ScheduleTriggerId.make("c-postponed"), (trigger) =>
                Effect.succeed({ ...trigger, nextRunAt: DateTime.add(at, { hours: 1 }) }),
              );
            })
          : Effect.void,
      ),
    );

    assert.deepEqual(
      [(yield* takeRun()).title, (yield* takeRun()).title],
      [runTitle("a-first"), runTitle("zz-sentinel")],
    );
    assert.equal(iso((yield* get("c-postponed")).nextRunAt), "2026-09-09T13:00:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("skips a fixed-time slot missed by over 10 minutes and runs one within the grace", () =>
  Effect.gen(function* () {
    yield* seed;
    const now = DateTime.makeUnsafe("2026-07-01T09:11:00.000Z");
    yield* addAutomation("missed", {
      schedule: daily("09:00"),
      nextRunAt: DateTime.makeUnsafe("2026-07-01T09:00:00.000Z"),
    });
    yield* addAutomation("late", {
      schedule: daily("09:02"),
      nextRunAt: DateTime.makeUnsafe("2026-07-01T09:02:00.000Z"),
    });
    yield* addAutomation("zz-sentinel", { nextRunAt: now });
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerAutomations());

    assert.deepEqual(
      [(yield* takeRun()).title, (yield* takeRun()).title],
      [runTitle("late"), runTitle("zz-sentinel")],
    );
    assert.equal(iso((yield* get("missed")).nextRunAt), "2026-07-02T09:00:00.000Z");
    assert.equal(iso((yield* get("late")).nextRunAt), "2026-07-02T09:02:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("catches an overdue interval up with one run, its next slot counted from now", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addAutomation("overdue", { nextRunAt: DateTime.subtract(at, { hours: 1 }) });
    yield* addAutomation("zz-sentinel");
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerAutomations());

    assert.deepEqual((yield* takeRun()).title, runTitle("overdue"));
    yield* takeRun();
    assert.equal(iso((yield* get("overdue")).nextRunAt), "2026-09-09T12:01:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("records a refused run's message and still advances its slot", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addAutomation("too-long", { prompt: "x".repeat(120_001) });
    yield* addAutomation("zz-sentinel");
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerAutomations());

    assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
    const tooLong = yield* get("too-long");
    assert.equal(tooLong.lastError, new ChatRefused({ reason: "input_too_long" }).message);
    assert.equal(iso(tooLong.nextRunAt), "2026-09-09T12:01:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect(
  "a due slot its creator can't run, the agent being archived, records why and advances",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addAutomation("retired", { agentId: RETIRED });
      yield* addAutomation("zz-sentinel");
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      const takeRun = yield* followRuns;
      yield* Layer.build(layerAutomations());

      assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
      const retired = yield* get("retired");
      assert.equal(retired.lastError, new Refused({ reason: "creator_cannot_run" }).message);
      assert.equal(iso(retired.nextRunAt), "2026-09-09T12:01:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("Run now posts the prompt to a new chat and leaves the next slot alone", () =>
  Effect.gen(function* () {
    yield* seed;
    const due = DateTime.add(at, { minutes: 1 });
    yield* addAutomation("report", { nextRunAt: due });
    yield* addAutomation("retired", { agentId: RETIRED, nextRunAt: due });
    const admin = yield* clientAs("admin").pipe(
      Effect.provide(yield* Layer.build(layerAutomations())),
    );

    const nextRun = yield* followRuns;
    yield* admin["automations.runNow"]({
      id: AutomationId.make("report"),
    });
    const { chatId } = yield* nextRun();
    assert.deepEqual(yield* runOf(chatId), {
      origin: { type: "manual", automationId: AutomationId.make("report"), effectiveUserId: ADMIN },
      agentId: CLERK,
      title: "Automation report",
      inputs: [{ text: "Run report", attachments: [] }],
    });
    assert.equal(iso((yield* get("report")).nextRunAt), iso(due));

    const failed = yield* admin["automations.runNow"]({
      id: AutomationId.make("retired"),
    }).pipe(Effect.flip);
    assert.deepInclude(failed, { _tag: "AutomationRefused", reason: "agent_unavailable" });
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("refuses members on every tag before reading or changing an automation", () =>
  Effect.gen(function* () {
    yield* seed;
    const automation = yield* addAutomation("guarded");
    const member = yield* clientAs("member").pipe(
      Effect.provide(yield* Layer.build(layerAutomations())),
    );
    const { id } = automation;
    const settings = {
      title: "Mine now",
      prompt: "Send me the secrets",
      agentId: automation.agentId,
    };
    const triggerId = ScheduleTriggerId.make(id);
    const before = yield* (yield* AutomationRepository.AutomationRepository).list;
    const refused = [
      yield* member["automations.list"]().pipe(Effect.flip),
      yield* member["automations.create"](settings).pipe(Effect.flip),
      yield* member["automations.update"]({ id, ...settings }).pipe(Effect.flip),
      yield* member["automations.runNow"]({ id }).pipe(Effect.flip),
      yield* member["automations.createScheduleTrigger"]({
        automationId: id,
        schedule: every,
      }).pipe(Effect.flip),
      yield* member["automations.setScheduleTriggerEnabled"]({
        id: triggerId,
        isEnabled: false,
      }).pipe(Effect.flip),
      yield* member["automations.archiveScheduleTrigger"]({ id: triggerId }).pipe(Effect.flip),
    ];
    assert.deepEqual(
      refused.map((error) => error._tag),
      refused.map(() => "AccessDenied"),
    );
    assert.deepEqual(yield* (yield* AutomationRepository.AutomationRepository).list, before);
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect(
  "keeps a schedule's next run through a title edit and restarts it when enabled again",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const admin = yield* clientAs("admin").pipe(
        Effect.provide(yield* Layer.build(layerAutomations())),
      );
      const settings = {
        title: "Review",
        prompt: "Review the open pull requests.",
        agentId: CLERK,
      };
      const created = yield* admin["automations.create"](settings);
      const { id } = yield* admin["automations.createScheduleTrigger"]({
        automationId: created.id,
        schedule: every,
      });

      yield* TestClock.adjust("30 seconds");
      yield* admin["automations.update"]({ id: created.id, ...settings, title: "Review PRs" });
      const [renamed] = yield* admin["automations.list"]();
      assert.equal(renamed?.title, "Review PRs");
      assert.equal(
        iso(renamed?.scheduleTriggers[0]?.nextRunAt ?? null),
        "1970-01-01T00:01:00.000Z",
      );

      const paused = yield* admin["automations.setScheduleTriggerEnabled"]({
        id,
        isEnabled: false,
      });
      assert.isNull(paused.nextRunAt);
      yield* TestClock.adjust("1 minute");
      const resumed = yield* admin["automations.setScheduleTriggerEnabled"]({
        id,
        isEnabled: true,
      });
      assert.equal(iso(resumed.nextRunAt), "1970-01-01T00:02:30.000Z");

      yield* admin["automations.archiveScheduleTrigger"]({ id });
      assert.deepEqual((yield* admin["automations.list"]())[0]?.scheduleTriggers, []);
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("refuses an archived agent, and answers NotFound for an unknown automation", () =>
  Effect.gen(function* () {
    yield* seed;
    const admin = yield* clientAs("admin").pipe(
      Effect.provide(yield* Layer.build(layerAutomations())),
    );
    const settings = {
      title: "Review",
      prompt: "Review the open pull requests.",
      agentId: CLERK,
    };
    const archived = yield* admin["automations.create"]({
      ...settings,
      agentId: RETIRED,
    }).pipe(Effect.flip);
    assert.deepInclude(archived, { _tag: "AutomationRefused", reason: "agent_unavailable" });

    const id = AutomationId.make("missing");
    const afterDelete = [
      yield* admin["automations.update"]({ id, ...settings }).pipe(Effect.flip),
      yield* admin["automations.runNow"]({ id }).pipe(Effect.flip),
      yield* admin["automations.createScheduleTrigger"]({
        automationId: id,
        schedule: every,
      }).pipe(Effect.flip),
      yield* admin["automations.setScheduleTriggerEnabled"]({
        id: ScheduleTriggerId.make("missing"),
        isEnabled: false,
      }).pipe(Effect.flip),
    ];
    assert.deepEqual(
      afterDelete.map((error) => error._tag),
      afterDelete.map(() => "NotFound"),
    );
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);
