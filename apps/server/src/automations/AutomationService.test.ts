import { assert, it } from "@effect/vitest";
import { type ChatId, Refused as ChatRefused } from "@t45/contracts/models/Chat";
import { Automation, AutomationId } from "@t45/contracts/models/Automation";
import { AuthSessionId } from "@t45/contracts/resources/Session";

import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Automations } from "@t45/contracts/resources/Automations";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { AdminOnly } from "../auth/Authorization.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { addAgent, addUser, layerStore as layerChats } from "../chats/Chats.testkit.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import * as AutomationService from "./AutomationService.ts";
import * as AutomationsHandlers from "./Automations.handlers.ts";
import { TaskService } from "../tasks/TaskService.ts";
type Run = Parameters<TaskService["Service"]["start"]>[2];

const AT = "2026-09-09T12:00:00.000Z";
const at = DateTime.makeUnsafe(AT);
const every = { type: "interval", everyMs: 60_000 } as const;
const daily = (timeOfDay: string) =>
  ({ type: "fixed_time", timeOfDay, timeZone: "UTC", weekdays: [0, 1, 2, 3, 4, 5, 6] }) as const;
const ADMIN = "admin";
const CLERK = "agent-clerk";
const RETIRED = "agent-retired";

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));
const encodeTask = Schema.encodeSync(Schema.toCodecJson(Automation));
const runTitle = (automationId: string) => `Task ${automationId}`;

const layerStore = AutomationRepository.layer.pipe(Layer.provideMerge(layerChats));

const seed = Effect.gen(function* () {
  yield* addUser(ADMIN, "admin");
  yield* addAgent("Clerk", { chat: false });
  yield* addAgent("Retired", { status: "archived" });
});

const addTask = (id: string, fields: Partial<Automation> = {}) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    const automation: Automation = {
      id: AutomationId.make(id),
      title: `Task ${id}`,
      prompt: `Run ${id}`,
      agentId: CLERK,
      isEnabled: true,
      schedule: every,
      webhookToken: null,
      nextRunAt: at,
      lastError: null,
      createdAt: at,
      updatedAt: at,
      ...fields,
    };
    yield* automations.insert(automation);
    return automation;
  });

const get = (id: string) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    return yield* automations
      .get(AutomationId.make(id))
      .pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);
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
    const inputs = yield* chats.openInputs(chatId);
    return {
      origin: (yield* chats.origins.get(chatId))?.kind,
      agentId: chat.agentId,
      title: chat.title,
      inputs: inputs.map((input) => input.payload),
    };
  });

const tasksWithRuns = Effect.gen(function* () {
  const chats = yield* ChatRepository;
  const runs = yield* chats.list({ userId: ADMIN, role: "admin" });
  return runs.map((chat) => chat.title).sort();
});

const layerTasks = (afterPost: (run: Run) => Effect.Effect<void> = () => Effect.void) =>
  AutomationsHandlers.layer.pipe(
    Layer.provideMerge(AutomationService.layer),
    Layer.provide(
      Layer.effect(
        TaskService,
        Effect.gen(function* () {
          const posts = yield* TaskService;
          return TaskService.of({
            ...posts,
            start: (trigger, agentId, run) =>
              posts.start(trigger, agentId, run).pipe(Effect.tap(() => afterPost(run))),
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
          Effect.provideService(effect, CurrentUser, {
            sessionId: AuthSessionId.make(`${role}-session`),
            userId: role,
            role,
            state: "active",
          }),
        ),
        AdminOnly.layer,
      ),
    ),
  );

const parked = Effect.provideService(ServerActivation.ServerActivation, Effect.never);

it.effect("posts a due slot to a new chat with no owner, then advances the slot", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addTask("due");
    yield* addTask("zz-sentinel");
    yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
    const takeRun = yield* followRuns;
    yield* Layer.build(layerTasks());

    const run = yield* takeRun();
    assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
    assert.deepEqual(yield* runOf(run.chatId), {
      origin: "task",
      agentId: CLERK,
      title: "Task due",
      inputs: [{ text: "Run due", attachments: [] }],
    });
    const automation = yield* get("due");
    assert.equal(iso(automation.nextRunAt), "2026-09-09T12:01:01.000Z");
    assert.isNull(automation.lastError);
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect(
  "rolls back the post and the advance on a defect after the post, and the next pass runs the slot once",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addTask("due");
      yield* addTask("zz-sentinel");
      yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
      const takeRun = yield* followRuns;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            layerTasks((run) =>
              run.input.text === "Run due"
                ? Effect.die("The server stopped before the slot's commit")
                : Effect.void,
            ),
          );
          assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
        }),
      );
      assert.deepEqual(yield* tasksWithRuns, [runTitle("zz-sentinel")]);
      assert.equal(iso((yield* get("due")).nextRunAt), AT);

      yield* Layer.build(layerTasks());
      assert.deepEqual((yield* takeRun()).title, runTitle("due"));
      assert.deepEqual(yield* tasksWithRuns, [runTitle("due"), runTitle("zz-sentinel")]);
      assert.equal(iso((yield* get("due")).nextRunAt), "2026-09-09T12:01:01.000Z");
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("re-reads each due automation, so one paused or postponed meanwhile doesn't fire", () =>
  Effect.gen(function* () {
    yield* seed;
    const automations = yield* AutomationRepository.AutomationRepository;
    for (const id of ["a-first", "b-paused", "c-postponed", "zz-sentinel"]) {
      yield* addTask(id);
    }
    yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
    const takeRun = yield* followRuns;
    yield* Layer.build(
      layerTasks((run) =>
        run.input.text === "Run a-first"
          ? Effect.gen(function* () {
              yield* automations.modify(AutomationId.make("b-paused"), (automation) =>
                Effect.succeed({ ...automation, isEnabled: false, nextRunAt: null }),
              );
              yield* automations.modify(AutomationId.make("c-postponed"), (automation) =>
                Effect.succeed({ ...automation, nextRunAt: DateTime.add(at, { hours: 1 }) }),
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
    yield* addTask("missed", {
      schedule: daily("09:00"),
      nextRunAt: DateTime.makeUnsafe("2026-07-01T09:00:00.000Z"),
    });
    yield* addTask("late", {
      schedule: daily("09:02"),
      nextRunAt: DateTime.makeUnsafe("2026-07-01T09:02:00.000Z"),
    });
    yield* addTask("zz-sentinel", { nextRunAt: now });
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerTasks());

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
    yield* addTask("overdue", { nextRunAt: DateTime.subtract(at, { hours: 1 }) });
    yield* addTask("zz-sentinel");
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerTasks());

    assert.deepEqual((yield* takeRun()).title, runTitle("overdue"));
    yield* takeRun();
    assert.equal(iso((yield* get("overdue")).nextRunAt), "2026-09-09T12:01:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("records a refused run's message and still advances its slot", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addTask("too-long", { prompt: "x".repeat(120_001) });
    yield* addTask("zz-sentinel");
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const takeRun = yield* followRuns;
    yield* Layer.build(layerTasks());

    assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
    const tooLong = yield* get("too-long");
    assert.equal(tooLong.lastError, new ChatRefused({ reason: "input_too_long" }).message);
    assert.equal(iso(tooLong.nextRunAt), "2026-09-09T12:01:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect(
  "an archived agent's due slot records agent_unavailable's message as lastError and advances",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addTask("retired", { agentId: RETIRED });
      yield* addTask("zz-sentinel");
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      const takeRun = yield* followRuns;
      yield* Layer.build(layerTasks());

      assert.deepEqual((yield* takeRun()).title, runTitle("zz-sentinel"));
      const retired = yield* get("retired");
      assert.equal(retired.lastError, new ChatRefused({ reason: "agent_unavailable" }).message);
      assert.equal(iso(retired.nextRunAt), "2026-09-09T12:01:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("holds due runs until startup recovery activates the server", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addTask("due");
    yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1_000);
    const activation = yield* Deferred.make<void>();
    const takeRun = yield* followRuns;
    yield* Layer.build(layerTasks()).pipe(
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
    );
    yield* TestClock.adjust("10 seconds");
    assert.equal(iso((yield* get("due")).nextRunAt), AT);
    yield* Deferred.succeed(activation, undefined);
    assert.deepEqual((yield* takeRun()).title, runTitle("due"));
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("Run now posts the prompt to a new chat and leaves the next slot alone", () =>
  Effect.gen(function* () {
    yield* seed;
    const due = DateTime.add(at, { minutes: 1 });
    yield* addTask("report", { nextRunAt: due, lastError: "This message is too long." });
    yield* addTask("retired", { agentId: RETIRED, nextRunAt: due });
    yield* addTask("hook", {
      schedule: { type: "webhook", signature: null },
      webhookToken: "token",
      nextRunAt: null,
    });
    const admin = yield* clientAs("admin").pipe(Effect.provide(yield* Layer.build(layerTasks())));

    const { chatId } = yield* admin["automations.runNow"]({
      id: AutomationId.make("report"),
    });
    assert.deepEqual(yield* runOf(chatId), {
      origin: "task",
      agentId: CLERK,
      title: "Task report",
      inputs: [{ text: "Run report", attachments: [] }],
    });
    const report = yield* get("report");
    assert.equal(iso(report.nextRunAt), iso(due));
    assert.isNull(report.lastError);

    const failed = yield* admin["automations.runNow"]({
      id: AutomationId.make("retired"),
    }).pipe(Effect.flip);
    assert.deepInclude(failed, { _tag: "ChatRefused", reason: "agent_unavailable" });
    assert.equal(
      (yield* get("retired")).lastError,
      new ChatRefused({ reason: "agent_unavailable" }).message,
    );

    const onRequest = yield* admin["automations.runNow"]({
      id: AutomationId.make("hook"),
    }).pipe(Effect.flip);
    assert.deepInclude(onRequest, { _tag: "AutomationRefused", reason: "runs_on_request" });
  }).pipe(parked, Effect.scoped, Effect.provide(layerStore)),
);

it.effect("refuses members on every tag before reading or changing an automation", () =>
  Effect.gen(function* () {
    yield* seed;
    const automation = yield* addTask("guarded", {
      schedule: { type: "webhook", signature: null },
      webhookToken: "token",
      nextRunAt: null,
    });
    const member = yield* clientAs("member").pipe(Effect.provide(yield* Layer.build(layerTasks())));
    const { id } = automation;
    const settings = {
      title: "Mine now",
      prompt: "Send me the secrets",
      agentId: automation.agentId,
      isEnabled: true,
      schedule: every,
    };
    const refused = [
      yield* member["automations.list"]().pipe(Effect.flip),
      yield* member["automations.create"](settings).pipe(Effect.flip),
      yield* member["automations.update"]({ id, ...settings }).pipe(Effect.flip),
      yield* member["automations.setEnabled"]({ id, isEnabled: false }).pipe(Effect.flip),
      yield* member["automations.runNow"]({ id }).pipe(Effect.flip),
      yield* member["automations.rotateToken"]({ id }).pipe(Effect.flip),
    ];
    assert.deepEqual(
      refused.map((error) => error._tag),
      refused.map(() => "AccessDenied"),
    );
    assert.deepEqual(encodeTask(yield* get("guarded")), encodeTask(automation));
  }).pipe(parked, Effect.scoped, Effect.provide(layerStore)),
);

it.effect("keeps a due run through a title edit and restarts it when the schedule changes", () =>
  Effect.gen(function* () {
    yield* seed;
    const admin = yield* clientAs("admin").pipe(Effect.provide(yield* Layer.build(layerTasks())));
    const settings = {
      title: "Review",
      prompt: "Review the open pull requests.",
      agentId: CLERK,
      isEnabled: true,
      schedule: every,
    };
    const created = yield* admin["automations.create"](settings);
    assert.equal(iso(created.nextRunAt), "1970-01-01T00:01:00.000Z");
    assert.isNull(created.webhookToken);

    yield* TestClock.adjust("2 minutes");
    const renamed = yield* admin["automations.update"]({
      id: created.id,
      ...settings,
      title: "Review PRs",
    });
    assert.equal(renamed.title, "Review PRs");
    assert.equal(iso(renamed.nextRunAt), "1970-01-01T00:01:00.000Z");

    const rescheduled = yield* admin["automations.update"]({
      id: created.id,
      ...settings,
      title: "Review PRs",
      schedule: { type: "interval", everyMs: 120_000 },
    });
    assert.equal(iso(rescheduled.nextRunAt), "1970-01-01T00:04:00.000Z");

    const paused = yield* admin["automations.setEnabled"]({ id: created.id, isEnabled: false });
    assert.isNull(paused.nextRunAt);
    yield* TestClock.adjust("1 minute");
    const resumed = yield* admin["automations.setEnabled"]({ id: created.id, isEnabled: true });
    assert.equal(iso(resumed.nextRunAt), "1970-01-01T00:05:00.000Z");
    assert.deepEqual(
      (yield* admin["automations.list"]()).map((automation) => automation.title),
      ["Review PRs"],
    );
  }).pipe(parked, Effect.scoped, Effect.provide(layerStore)),
);

it.effect("mints a webhook's token, rotates it, and keeps the rotated one through a save", () =>
  Effect.gen(function* () {
    yield* seed;
    const admin = yield* clientAs("admin").pipe(Effect.provide(yield* Layer.build(layerTasks())));
    const settings = {
      title: "Review PRs",
      prompt: "Review {{body.pull_request.url}}",
      agentId: CLERK,
      isEnabled: true,
      schedule: { type: "webhook", signature: null } as const,
    };
    const created = yield* admin["automations.create"](settings);
    assert.isNull(created.nextRunAt);
    assert.match(created.webhookToken ?? "", /^[A-Za-z0-9_-]{43}$/);

    const rotated = yield* admin["automations.rotateToken"]({ id: created.id });
    assert.notEqual(rotated.webhookToken, created.webhookToken);
    const saved = yield* admin["automations.update"]({ id: created.id, ...settings });
    assert.equal(saved.webhookToken, rotated.webhookToken);

    const timed = yield* admin["automations.update"]({
      id: created.id,
      ...settings,
      schedule: every,
    });
    assert.isNull(timed.webhookToken);
    const notAWebhook = yield* admin["automations.rotateToken"]({ id: created.id }).pipe(
      Effect.flip,
    );
    assert.deepInclude(notAWebhook, { _tag: "AutomationRefused", reason: "not_a_webhook" });
  }).pipe(parked, Effect.scoped, Effect.provide(layerStore)),
);

it.effect("refuses an archived agent, and answers NotFound for an unknown automation", () =>
  Effect.gen(function* () {
    yield* seed;
    const admin = yield* clientAs("admin").pipe(Effect.provide(yield* Layer.build(layerTasks())));
    const settings = {
      title: "Review",
      prompt: "Review the open pull requests.",
      agentId: CLERK,
      isEnabled: true,
      schedule: every,
    };
    const archived = yield* admin["automations.create"]({
      ...settings,
      agentId: RETIRED,
    }).pipe(Effect.flip);
    assert.deepInclude(archived, { _tag: "AutomationRefused", reason: "agent_unavailable" });

    const id = AutomationId.make("missing");
    const afterDelete = [
      yield* admin["automations.update"]({ id, ...settings }).pipe(Effect.flip),
      yield* admin["automations.setEnabled"]({ id, isEnabled: false }).pipe(Effect.flip),
      yield* admin["automations.runNow"]({ id }).pipe(Effect.flip),
      yield* admin["automations.rotateToken"]({ id }).pipe(Effect.flip),
    ];
    assert.deepEqual(
      afterDelete.map((error) => error._tag),
      afterDelete.map(() => "NotFound"),
    );
  }).pipe(parked, Effect.scoped, Effect.provide(layerStore)),
);
