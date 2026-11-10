import { assert, it } from "@effect/vitest";
import type { ChatId } from "@t45/contracts/models/Chat";
import { type Automation, AutomationId } from "@t45/contracts/models/Automation";
import { AuthSessionId } from "@t45/contracts/resources/Session";

import { Authorization, CurrentActor } from "@t45/contracts/Authorization";
import { Automations } from "@t45/contracts/resources/Automations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import { AdminOnly } from "../auth/Authorization.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { addAgent, addUser, layer as layerChats } from "../chats/Chats.testkit.ts";
import { FakeRunner } from "../runner/FakeRunner.testkit.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import * as AutomationsHandlers from "./Automations.handlers.ts";

const at = DateTime.makeUnsafe("2026-09-09T12:00:00.000Z");
const ADMIN = "user-admin";
const CLERK = "agent-clerk";
const RETIRED = "agent-retired";

const layerStore = AutomationRepository.layer.pipe(Layer.provideMerge(layerChats));

const seed = Effect.gen(function* () {
  // Inputs stay pending, so `runOf` reads every input a run got.
  (yield* FakeRunner).hold = true;
  yield* addUser(ADMIN, "admin");
  yield* addAgent("Clerk", { chat: false });
  yield* addAgent("Retired", { status: "archived" });
});

const addAutomation = (id: string, agentId = CLERK) =>
  Effect.gen(function* () {
    const automations = yield* AutomationRepository.AutomationRepository;
    const automation: Automation = {
      id: AutomationId.make(id),
      title: `Automation ${id}`,
      prompt: `Run ${id}`,
      agentId,
      isArchived: false,
      createdAt: at,
      updatedAt: at,
    };
    yield* automations.save(automation);
    return automation;
  });

const followRuns = Effect.gen(function* () {
  const changes = yield* ChatEvents;
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
  return () => Queue.take(runs).pipe(Effect.orDie);
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

it.effect("Run now posts the prompt to a new chat", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addAutomation("report");
    yield* addAutomation("retired", RETIRED);
    const admin = yield* clientAs("admin").pipe(
      Effect.provide(yield* Layer.build(AutomationsHandlers.layer)),
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
      Effect.provide(yield* Layer.build(AutomationsHandlers.layer)),
    );
    const { id } = automation;
    const settings = {
      title: "Mine now",
      prompt: "Send me the secrets",
      agentId: automation.agentId,
    };
    const before = yield* (yield* AutomationRepository.AutomationRepository).list;
    const refused = [
      yield* member["automations.list"]().pipe(Effect.flip),
      yield* member["automations.create"](settings).pipe(Effect.flip),
      yield* member["automations.update"]({ id, ...settings }).pipe(Effect.flip),
      yield* member["automations.runNow"]({ id }).pipe(Effect.flip),
    ];
    assert.deepEqual(
      refused.map((error) => error._tag),
      refused.map(() => "AccessDenied"),
    );
    assert.deepEqual(yield* (yield* AutomationRepository.AutomationRepository).list, before);
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("refuses an archived agent, and answers NotFound for an unknown automation", () =>
  Effect.gen(function* () {
    yield* seed;
    const admin = yield* clientAs("admin").pipe(
      Effect.provide(yield* Layer.build(AutomationsHandlers.layer)),
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
    ];
    assert.deepEqual(
      afterDelete.map((error) => error._tag),
      afterDelete.map(() => "NotFound"),
    );
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);
