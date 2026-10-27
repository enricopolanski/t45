import { AutomationId } from "@t45/contracts/models/Automation";
import { ChatService } from "../chats/ChatService.ts";
import { assert, describe, it } from "@effect/vitest";
import { Form } from "@opencode/client/effect";
import type { ChatId } from "@t45/contracts/models/Chat";

import type { ChatEvent, ChatSummary } from "@t45/contracts/resources/Chats";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import { inputMessageId, isNoteOf, noteMessageId, rootSessionId } from "../chats/ChatIds.ts";
import * as ChatRepository from "../chats/ChatRepository.ts";
import * as Fixture from "../chats/Chats.testkit.ts";
import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";
import * as FakeRunner from "./FakeRunner.testkit.ts";
import { resumePrompt } from "./PromptService.ts";
import { RunnerService } from "./RunnerService.ts";

const { openCode, runner } = Fixture;

const alice = { userId: "user-alice", role: "member" } as const;
const admin = { userId: "admin01", role: "admin" } as const;

const setup = Effect.gen(function* () {
  Fixture.resetFakes();
  yield* Fixture.addUser(alice.userId);
  const agentId = yield* Fixture.addAgent("Clerk");
  const chatId = yield* Fixture.seedChat({
    id: Fixture.testChatId(1),
    ownerUserId: alice.userId,
    agentId,
  });
  return {
    chats: yield* ChatService,
    chatId,
    agentId,
    root: rootSessionId(chatId),
  };
});

type Events = Effect.Success<ReturnType<typeof Fixture.follow>>;

type Messages = Extract<ChatEvent, { _tag: "messages" }>;

/** The ledger's state of the chat's input `inputId`. */
const inputState = (chatId: ChatId, inputId: string) =>
  Effect.flatMap(ChatRepository.ChatRepository, (repository) =>
    repository.input(chatId, inputId),
  ).pipe(Effect.map((input) => input?.state));

const stopRequest = (chatId: ChatId) =>
  Effect.flatMap(ChatRepository.ChatRepository, (repository) => repository.stopRequest(chatId));

const inputTexts = (chatId: ChatId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly text: string }>`SELECT
        json_extract(payload_json, '$.text') AS text
      FROM chat_inputs WHERE chat_id = ${chatId} ORDER BY ordinal`;
    return rows.map((row) => row.text);
  });

const writeInput = (chatId: ChatId, inputId: string, text: string) =>
  Effect.gen(function* () {
    const repository = yield* ChatRepository.ChatRepository;
    yield* repository.addInput(chatId, {
      inputId,
      payload: { text, attachments: [] },
      at: DateTime.formatIso(yield* DateTime.now),
    });
    yield* repository.markRunning(chatId);
  });

const hasStatus =
  (status: ChatSummary["status"]) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "chat" }> =>
    event._tag === "chat" && event.chat.status === status;

/** Chat events once the chat has nothing to do. */
const isIdle = hasStatus(null);

const noInputs = (event: ChatEvent): event is Extract<ChatEvent, { _tag: "inputs" }> =>
  event._tag === "inputs" && event.inputs.length === 0;

/** Questions events listing `count` questions. */
const asking =
  (count: number) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "questions" }> =>
    event._tag === "questions" && event.questions.length === count;

const listing =
  (sessionId: string) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "sessions" }> =>
    event._tag === "sessions" && event.sessions.some((session) => session.id === sessionId);

const telling =
  (text: string) =>
  (event: ChatEvent): event is ChatEvent =>
    (event._tag === "snapshot" || event._tag === "messages") &&
    event.messages.some((each) => each.message.type === "user" && each.message.text === text);

const midStep = (events: Events, chatId: ChatId) =>
  Effect.gen(function* () {
    const unfinished = FakeOpenCode.answerText(openCode, chatId, "Adding up", {
      streaming: true,
    });
    FakeOpenCode.emit(openCode, chatId, "session.inbox.delivered", {
      sessionID: rootSessionId(chatId),
      inboxID: unfinished,
    });
    yield* Fixture.next(events, Fixture.showing(unfinished, "live"));
    return unfinished;
  });

const crashVm = (chatId: ChatId) => {
  runner.chats.delete(chatId);
  runner.boots.delete(chatId);
  FakeOpenCode.crash(openCode, chatId);
};

describe("a chat's worker", () => {
  it.effect(
    "starts the chat's VM, delivers each input once under its own id, and keeps what the agent writes",
    () =>
      Effect.gen(function* () {
        const { chats, chatId } = yield* setup;
        const events = yield* Fixture.follow(chatId, alice);
        yield* chats.send(
          { chatId, inputId: "input-1", text: "What changed?", attachments: [] },
          alice,
        );

        const sent = inputMessageId(chatId, "input-1");
        // The member's input no longer waits, and is in the chat now.
        yield* Fixture.next(events, noInputs);
        yield* Fixture.next(events, Fixture.showing(sent, "settled"));
        assert.deepEqual(
          openCode.prompts.map((prompt) => prompt.id),
          [sent],
        );
        assert.deepEqual(openCode.prompts[0]?.metadata, {
          t45: { text: "What changed?", attachments: [] },
        });
        assert.isTrue(runner.chats.has(chatId));

        const answer = FakeOpenCode.answerText(openCode, chatId, "Rent went up.");
        FakeOpenCode.finishTurn(openCode, chatId);
        const written = yield* Fixture.next(events, Fixture.showing(answer, "settled"));
        assert.deepEqual(Fixture.texts(written), ["Rent went up."]);

        yield* chats.send(
          { chatId, inputId: "input-2", text: "And food?", attachments: [] },
          alice,
        );
        yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-2")));
        assert.deepEqual(
          openCode.prompts.map((prompt) => prompt.id),
          [sent, inputMessageId(chatId, "input-2")],
        );

        FakeOpenCode.failTurn(openCode, chatId, "The provider refused the turn.");
        yield* Fixture.next(events, hasStatus("failed"));
        FakeOpenCode.interruptTurn(openCode, chatId);
        yield* Fixture.next(events, hasStatus("interrupted"));
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("answers a queued job after the VM's event stream disconnects", () =>
    Effect.gen(function* () {
      const { chatId, root } = yield* setup;
      const workers = yield* RunnerService;
      yield* workers.run(chatId, () => Effect.void, { boot: true });
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* workers
        .run(chatId, () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      FakeOpenCode.dropStreams(openCode, chatId);
      const next = yield* workers
        .run(chatId, (running) => Effect.succeed(running.root))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      assert.deepStrictEqual(yield* Fiber.join(next), Option.some(root));
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("abandons running and queued jobs when their caller leaves or times out", () =>
    Effect.gen(function* () {
      const { chatId, root } = yield* setup;
      const workers = yield* RunnerService;
      yield* workers.run(chatId, () => Effect.void, { boot: true });
      const interruptedStart = yield* Deferred.make<void>();
      const interruptedEnd = yield* Deferred.make<void>();
      const interrupted = yield* workers
        .run(chatId, () =>
          Deferred.succeed(interruptedStart, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interruptedEnd, undefined)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(interruptedStart);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.await(interruptedEnd);
      const started = yield* Deferred.make<void>();
      const stuck = yield* workers
        .run(chatId, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 minutes");
      assert.strictEqual((yield* Effect.flip(Fiber.join(stuck)))._tag, "JobTimeoutError");
      assert.deepStrictEqual(
        yield* workers.run(chatId, (running) => Effect.succeed(running.root)),
        Option.some(root),
      );

      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* workers
        .run(chatId, () =>
          Deferred.succeed(holding, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.uninterruptible,
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      let abandonedRan = false;
      const abandoned = yield* workers
        .run(chatId, () =>
          Effect.sync(() => {
            abandonedRan = true;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(abandoned);
      let ran = false;
      const left = yield* workers
        .run(chatId, () =>
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("3 minutes");
      assert.strictEqual((yield* Effect.flip(Fiber.join(left)))._tag, "JobTimeoutError");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Effect.flip(Fiber.join(held)))._tag, "JobTimeoutError");
      yield* workers.run(chatId, () => Effect.void);
      assert.isFalse(ran);
      assert.isFalse(abandonedRan);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("keeps trying while the VM doesn't answer, never failing the chat", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      let failed = false;
      const settled = (inputId: string) => (event: ChatEvent) => {
        if (event._tag === "chat" && event.chat.status === "failed") failed = true;
        return Fixture.showing(inputMessageId(chatId, inputId), "settled")(event);
      };

      yield* chats.send({ chatId, inputId: "input-1", text: "Hi.", attachments: [] }, alice);
      yield* Fixture.next(events, settled("input-1"));

      openCode.unansweredPrompts.add("Again.");
      yield* chats.send({ chatId, inputId: "input-2", text: "Again.", attachments: [] }, alice);
      yield* Fixture.next(events, settled("input-2"));
      assert.isFalse(failed);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("cancels an input OpenCode refuses, tells members why, and delivers the next", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      openCode.invalidPrompts.set("Too long.", "The prompt is too long.");
      yield* chats.send({ chatId, inputId: "input-1", text: "Too long.", attachments: [] }, alice);
      const noted = yield* Fixture.next(
        events,
        (event): event is Messages =>
          event._tag === "messages" &&
          event.messages.some((each) => isNoteOf(chatId, "refused", each.message.id)),
      );
      const note = noted.messages.find((each) => isNoteOf(chatId, "refused", each.message.id));
      assert.include(
        note?.message.type === "synthetic" ? note.message.text : "",
        "The prompt is too long.",
      );
      assert.equal(yield* inputState(chatId, "input-1"), "cancelled");

      yield* Fixture.deliver(events, { chatId, inputId: "input-2", text: "Short." }, alice);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("lets go of a subagent's session removed in the VM, without restoring the chat", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "Research it." }, alice);
      const child = FakeOpenCode.chatSubagent(openCode, chatId);
      const unfinished = FakeOpenCode.answerText(openCode, chatId, "Looking", {
        sessionId: child,
        streaming: true,
      });
      // T45 reads the VM in full when it reconnects, and finds the subagent mid-step.
      FakeOpenCode.dropStreams(openCode, chatId);
      yield* Fixture.next(events, listing(child));
      const childEvents = yield* Fixture.follow(chatId, alice, child);
      yield* Fixture.next(childEvents, Fixture.showing(unfinished, "live"));

      // The agent removes the subagent's session while T45's stream to the VM is down.
      openCode.subagents.delete(child);
      FakeOpenCode.dropStreams(openCode, chatId);
      yield* Fixture.next(childEvents, Fixture.showing(unfinished, "lost"));
      // The root was never missing, so nothing was restored.
      assert.equal(openCode.imports.size, 0);
      yield* chats.send({ chatId, inputId: "input-2", text: "Go on.", attachments: [] }, alice);
      const next = yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-2")));
      assert.isFalse(next.messages.some((each) => isNoteOf(chatId, "restore", each.message.id)));
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("answers an agent's question in its VM, naming the files sent with the answer", () =>
    Effect.gen(function* () {
      const { chats, chatId, root } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "File my taxes." }, alice);
      const formId = FakeOpenCode.ask(openCode, chatId);
      const asked = yield* Fixture.next(events, asking(1));
      assert.equal(asked.questions[0]?.form.id, formId);
      yield* Fixture.next(events, hasStatus("waiting"));

      const files = yield* AttachmentRepository;
      const { id: upload } = yield* files.upload(
        { type: "file", name: "w2.txt", mimeType: "text/plain", sizeBytes: 2 },
        alice.userId,
        Stream.make(new Uint8Array([4, 2])),
      );
      yield* chats.answer(
        {
          chatId,
          sessionId: root,
          formId: Form.ID.make(formId),
          answers: { year: "2025" },
          attachments: {
            year: [
              { type: "file", id: upload, name: "w2.txt", mimeType: "text/plain", sizeBytes: 2 },
            ],
          },
        },
        alice,
      );
      const answered = String(openCode.formReplies.get(`${chatId}:${formId}`)?.year);
      assert.include(answered, "2025");
      assert.include(answered, `/work/attachments/${upload}`);
      assert.deepEqual(
        runner.chatFiles.get(`${chatId}:attachments/${upload}`),
        new Uint8Array([4, 2]),
      );
      yield* Fixture.next(events, asking(0));
      assert.equal(
        yield* chats
          .answer(
            {
              chatId,
              sessionId: root,
              formId: Form.ID.make(formId),
              answers: { year: "2024" },
              attachments: {},
            },
            alice,
          )
          .pipe(Effect.flip, Effect.map(Fixture.failureOf)),
        "question_gone",
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("puts the chat's files into each new boot from the store", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const files = yield* AttachmentRepository;
      const events = yield* Fixture.follow(chatId, alice);
      const receipt = yield* files.upload(
        { type: "file", name: "receipt.txt", mimeType: "text/plain", sizeBytes: 2 },
        alice.userId,
        Stream.make(new Uint8Array([4, 2])),
      );
      yield* chats.send(
        {
          chatId,
          inputId: "input-1",
          text: "File it.",
          attachments: [
            {
              type: "file",
              id: receipt.id,
              name: "receipt.txt",
              mimeType: "text/plain",
              sizeBytes: 2,
            },
          ],
        },
        alice,
      );
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-1"), "settled"));
      const policy = yield* files.store({
        name: "policy.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([7]),
        uploader: alice.userId,
      });
      yield* files.bindToChat(
        chatId,
        [
          {
            type: "file",
            id: policy.id,
            name: "policy.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        ],
        alice.userId,
      );
      FakeOpenCode.finishTurn(openCode, chatId);
      yield* Fixture.next(events, isIdle);
      yield* TestClock.adjust("5 minutes");
      yield* FakeRunner.removed(runner, chatId);

      yield* Fixture.deliver(events, { chatId, inputId: "input-2", text: "Email both." }, alice);
      assert.deepEqual(
        new Map(runner.chatFiles),
        new Map([
          [`${chatId}:attachments/${receipt.id}`, new Uint8Array([4, 2])],
          [`${chatId}:attachments/${policy.id}`, new Uint8Array([7])],
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("stop cancels the inputs waiting their turn, in T45 and in OpenCode", () =>
    Effect.gen(function* () {
      const { chats, chatId, root } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-1", text: "Sort the files." },
        alice,
      );
      FakeOpenCode.hold(openCode, chatId, true);
      yield* chats.send(
        { chatId, inputId: "input-2", text: "Then zip them.", attachments: [] },
        alice,
      );
      yield* Fixture.caughtUp(chatId);
      assert.equal(yield* inputState(chatId, "input-2"), "admitted");

      const shell = FakeOpenCode.runningShell(openCode, chatId);
      yield* chats.stop({ chatId }, alice);
      yield* Fixture.caughtUp(chatId);
      assert.equal(yield* inputState(chatId, "input-2"), "cancelled");
      assert.deepEqual(openCode.sessions.get(chatId)?.inbox, []);
      assert.include(openCode.interrupts, `${chatId}:${root}`);
      assert.deepEqual(openCode.removedShells, [`${chatId}:${shell}`]);
      yield* Fixture.next(events, noInputs);
      // Whatever wakes the agent next, input-2 isn't in its inbox to run.
      FakeOpenCode.hold(openCode, chatId, false);
      assert.isFalse(
        openCode.sessions
          .get(chatId)
          ?.items.some((item) => item.id === inputMessageId(chatId, "input-2")),
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("a stop on a sleeping chat cancels its inputs without starting its VM", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const repository = yield* ChatRepository.ChatRepository;
      yield* writeInput(chatId, "input-1", "Sort the files.");
      yield* writeInput(chatId, "input-2", "Then zip them.");
      yield* repository.moveInput(chatId, "input-1", ["waiting"], "admitted");

      yield* chats.stop({ chatId }, alice);
      yield* Fixture.caughtUp(chatId);
      assert.deepEqual(
        [yield* inputState(chatId, "input-1"), yield* inputState(chatId, "input-2")],
        ["cancelled", "cancelled"],
      );
      assert.equal((yield* repository.get(chatId))?.status, null);
      assert.deepEqual(runner.starts, []);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("a stop requested while an input is being delivered is carried out after it", () =>
    Effect.gen(function* () {
      const { chats, chatId, root } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-1", text: "Sort the files." },
        alice,
      );
      FakeOpenCode.hold(openCode, chatId, true);

      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      openCode.holdPrompt = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      yield* chats.send(
        { chatId, inputId: "input-2", text: "Then zip them.", attachments: [] },
        alice,
      );
      yield* Deferred.await(reached);
      const posted = yield* (yield* ChatEvents)
        .subscribe((change) => change.kind === "posted")
        .pipe(Effect.flatMap((stream) => Stream.toQueue(stream, { capacity: "unbounded" })));
      const stopping = yield* chats.stop({ chatId }, alice).pipe(Effect.forkChild);
      yield* Queue.take(posted).pipe(Effect.orDie);
      assert.equal(yield* inputState(chatId, "input-2"), "waiting");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      yield* Fixture.caughtUp(chatId);

      assert.equal(yield* inputState(chatId, "input-2"), "cancelled");
      assert.include(openCode.interrupts, `${chatId}:${root}`);
      assert.isNull(yield* stopRequest(chatId));
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("a post in a caller's transaction commits while the chat's VM is being removed", () =>
    Effect.gen(function* () {
      const { chatId, chats } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-1", text: "Sort the files." },
        alice,
      );
      FakeOpenCode.finishTurn(openCode, chatId);
      yield* Fixture.next(events, isIdle);

      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      runner.holdRemove = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(reached);
      yield* sql.withTransaction(
        chats.send({ chatId, inputId: "input-2", text: "Then zip them.", attachments: [] }, alice),
      );
      assert.equal(yield* inputState(chatId, "input-2"), "waiting");

      yield* Deferred.succeed(release, undefined);
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-2"), "settled"));
      assert.deepEqual(runner.removedChats, [chatId]);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("the sweep starts the worker of a chat whose input was saved without a wake", () =>
    Effect.gen(function* () {
      const { chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* writeInput(chatId, "input-1", "Sort the files.");
      yield* TestClock.adjust("30 seconds");
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-1"), "settled"));
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("refuses to cancel an input OpenCode already delivered, which stays the agent's", () =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-1", text: "Sort the files." },
        alice,
      );
      FakeOpenCode.hold(openCode, chatId, true);
      yield* chats.send(
        { chatId, inputId: "input-2", text: "Then zip them.", attachments: [] },
        alice,
      );
      yield* Fixture.caughtUp(chatId);
      // The turn ends and OpenCode delivers input-2 before T45 hears of it.
      FakeOpenCode.hold(openCode, chatId, false);

      const refused = yield* chats
        .cancel({ chatId, inputId: "input-2" }, alice)
        .pipe(Effect.flip, Effect.map(Fixture.failureOf));
      assert.equal(refused, "already_taken");
      assert.equal(yield* inputState(chatId, "input-2"), "materialized");
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect.each([
    ["it sent the input", "input"],
    ["the VM's boot", "boot"],
  ] as const)(
    "doesn't send again an input the VM already holds, when T45 restarted before recording %s",
    ([, unrecorded]) =>
      Effect.gen(function* () {
        const { chats, chatId } = yield* setup;
        const workers = yield* RunnerService;
        const sql = yield* SqlClient.SqlClient;
        const events = yield* Fixture.follow(chatId, alice);
        const first = inputMessageId(chatId, "input-1");
        yield* Fixture.deliver(
          events,
          { chatId, inputId: "input-1", text: "Sort the files." },
          alice,
        );
        FakeOpenCode.finishTurn(openCode, chatId);
        yield* Fixture.next(events, isIdle);
        FakeOpenCode.hold(openCode, chatId, true);
        yield* chats.send(
          { chatId, inputId: "input-2", text: "Then zip them.", attachments: [] },
          alice,
        );
        yield* Fixture.caughtUp(chatId);
        assert.equal(yield* inputState(chatId, "input-2"), "admitted");

        // T45 goes down and OpenCode makes input-2 a message T45 never reads, while the ledger
        // lags the VM as if T45 had died before recording it.
        yield* workers.stop(chatId);
        FakeOpenCode.hold(openCode, chatId, false);
        if (unrecorded === "input") {
          yield* sql`UPDATE chat_inputs SET state = 'waiting' WHERE input_id = 'input-2'`;
        } else {
          yield* sql`UPDATE chats SET boot_id = NULL WHERE id = ${chatId}`;
        }

        yield* chats.start(Fixture.stepHooks);
        // A job runs once the worker caught up and delivered what woke it.
        yield* workers.run(chatId, () => Effect.void);
        assert.equal(yield* inputState(chatId, "input-2"), "materialized");
        assert.deepEqual(
          openCode.prompts.map((prompt) => prompt.id),
          [first, inputMessageId(chatId, "input-2")],
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "gives up on a workspace the runner keeps refusing, says so once, and lets the chat sleep",
    () =>
      Effect.gen(function* () {
        const { chatId } = yield* setup;
        const events = yield* Fixture.follow(chatId, alice);
        const sql = yield* SqlClient.SqlClient;
        const notes = sql<{ readonly id: string; readonly state: string }>`SELECT
            message_id AS id, state FROM chat_messages WHERE message_id LIKE 'msg_t45_%workspace.%'`;
        // As when the agent left a file in /work that it can't read.
        runner.refuseWorkspace = "tar exited with 2";
        for (const inputId of ["input-1", "input-2", "input-3"]) {
          assert.deepEqual(yield* notes, []);
          yield* Fixture.deliver(events, { chatId, inputId, text: "Build it." }, alice);
          FakeOpenCode.finishTurn(openCode, chatId);
          yield* Fixture.next(events, isIdle);
        }
        const [note] = yield* notes;
        assert.isDefined(note);
        assert.equal(note.state, "settled");
        // T45 keeps the note, and members see it; OpenCode holds it for the agent's next turn and
        // runs none for it.
        const snapshot = yield* Fixture.next(
          yield* Fixture.follow(chatId, alice),
          Fixture.isSnapshot,
        );
        assert.isTrue(snapshot.messages.some((each) => each.message.id === note.id));
        const session = openCode.sessions.get(chatId);
        assert.deepEqual(
          session?.inbox.map((item) => item.id),
          [note.id],
        );
        assert.isFalse(session?.items.some((item) => item.id === note.id));

        yield* TestClock.adjust("5 minutes");
        yield* FakeRunner.removed(runner, chatId);
        assert.lengthOf(yield* notes, 1);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("keeps each chat's copy its own, whatever sessions another chat's VM makes", () =>
    Effect.gen(function* () {
      const { chatId, agentId } = yield* setup;
      const other = Fixture.testChatId(2);
      yield* Fixture.seedChat({ id: other, ownerUserId: alice.userId, agentId });
      const otherEvents = yield* Fixture.follow(other, alice);
      yield* Fixture.deliver(
        otherEvents,
        { chatId: other, inputId: "input-1", text: "Hi." },
        alice,
      );
      const reply = FakeOpenCode.answerText(openCode, other, "Hello.");
      FakeOpenCode.finishTurn(openCode, other);
      yield* Fixture.next(otherEvents, Fixture.showing(reply, "settled"));

      // Chat-1's agent makes a session named as chat-2's root, under its own, and writes in it;
      // T45 reads it all when it reconnects to the VM.
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "Go." }, alice);
      const borrowed = FakeOpenCode.chatSubagent(openCode, chatId, rootSessionId(other));
      const injected = FakeOpenCode.answerText(openCode, chatId, "Injected.", {
        sessionId: borrowed,
      });
      FakeOpenCode.dropStreams(openCode, chatId);
      yield* Fixture.next(events, listing(borrowed));
      yield* Fixture.next(
        yield* Fixture.follow(chatId, alice, rootSessionId(other)),
        Fixture.showing(injected),
      );

      const snapshot = yield* Fixture.next(yield* Fixture.follow(other, alice), Fixture.isSnapshot);
      assert.deepEqual(Fixture.texts(snapshot), ["Hello."]);
      assert.deepEqual(
        snapshot.sessions.map((session) => [session.id, session.parentID ?? null]),
        [[rootSessionId(other), null]],
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "sleeps after five idle minutes, saves its workspace, and restores into a VM with the latest agent setup",
    () =>
      Effect.gen(function* () {
        const { chatId, agentId, root } = yield* setup;
        const events = yield* Fixture.follow(chatId, alice);
        const first = inputMessageId(chatId, "input-1");
        yield* Fixture.deliver(
          events,
          { chatId, inputId: "input-1", text: "Sum the receipts." },
          alice,
        );
        // Saving after the turn fails, so only the save before sleeping keeps /work.
        runner.refuseWorkspace = "The workspace could not be saved.";
        runner.workspaces.set(chatId, new Uint8Array([7, 7, 7]));
        const done = FakeOpenCode.answerText(openCode, chatId, "The sum is 420.");
        const idle = FakeOpenCode.finishTurn(openCode, chatId);
        yield* Fixture.next(events, isIdle);
        runner.refuseWorkspace = null;
        const boot = runner.boots.get(chatId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agents SET instructions = 'Use the updated policy.',
          model = 'opencode-go/updated-model', network = 'open',
          mcp_servers = '{"docs":{"type":"remote","url":"https://docs.example"}}',
          files = '{"policy.md":"The updated policy."}'
          WHERE id = ${agentId}`;
        assert.include(runner.chats.get(chatId)?.agent.instructions, "Be brief.");

        yield* TestClock.adjust("5 minutes");
        yield* FakeRunner.removed(runner, chatId);

        const second = inputMessageId(chatId, "input-2");
        yield* Fixture.deliver(events, { chatId, inputId: "input-2", text: "Email it." }, alice);
        assert.notEqual(runner.boots.get(chatId), boot);
        const updated = runner.chats.get(chatId);
        assert.include(updated?.agent.instructions, "Use the updated policy.");
        assert.deepEqual(openCode.sessions.get(chatId)?.model, {
          providerID: "opencode-go",
          id: "updated-model",
        });
        assert.strictEqual(updated?.agent.permissions.network, "open");
        assert.deepEqual(updated?.agent.mcpServers, {
          docs: { type: "remote", url: "https://docs.example" },
        });
        assert.deepEqual(updated?.agent.files, { "policy.md": "The updated policy." });
        assert.deepEqual(runner.workspaces.get(chatId), new Uint8Array([7, 7, 7]));
        // Nothing was going on when it slept, so no note tells the agent what was lost.
        assert.deepEqual(openCode.imports.get(`${chatId}:${root}`), [first, done, idle]);
        assert.deepEqual(
          openCode.sessions.get(chatId)?.items.map((item) => item.id),
          [first, done, idle, second],
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "keeps a chat whose question waits awake for 30 minutes, then cancels the question and sleeps once idle",
    () =>
      Effect.gen(function* () {
        const { chatId } = yield* setup;
        const events = yield* Fixture.follow(chatId, alice);
        yield* Fixture.deliver(
          events,
          { chatId, inputId: "input-1", text: "File my taxes." },
          alice,
        );
        // The question blocks the agent's turn, which stays active while it waits.
        const formId = FakeOpenCode.ask(openCode, chatId);
        yield* Fixture.next(events, asking(1));

        yield* TestClock.adjust("30 minutes");
        yield* Fixture.next(events, asking(0));
        assert.deepEqual(openCode.cancelledForms, [`${chatId}:${formId}`]);
        assert.deepEqual(runner.removedChats, []);

        // The agent hears nobody answered and ends its turn; five idle minutes later the chat sleeps.
        FakeOpenCode.finishTurn(openCode, chatId);
        yield* Fixture.next(events, isIdle);
        yield* TestClock.adjust("5 minutes");
        yield* FakeRunner.removed(runner, chatId);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect.each([
    ["an input waits behind the agent's turn", "input"],
    ["a compaction waits in OpenCode's inbox", "compaction"],
  ] as const)("doesn't sleep while %s", ([, blocker]) =>
    Effect.gen(function* () {
      const { chats, chatId } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-1", text: "Sort the files." },
        alice,
      );
      FakeOpenCode.finishTurn(openCode, chatId);
      yield* Fixture.next(events, isIdle);
      if (blocker === "input") {
        FakeOpenCode.hold(openCode, chatId, true);
        yield* chats.send(
          { chatId, inputId: "input-2", text: "Then zip them.", attachments: [] },
          alice,
        );
        // A job runs after the worker delivered what woke it: input-2 waits in OpenCode's inbox.
        yield* Fixture.caughtUp(chatId);
        assert.equal(yield* inputState(chatId, "input-2"), "admitted");
      } else {
        yield* chats.compact({ chatId }, alice);
      }
      // A subagent no event announced: only the full read the worker makes before it sleeps
      // finds it, which shows the worker looked.
      const unseen = FakeOpenCode.chatSubagent(openCode, chatId);
      FakeOpenCode.endTurn(openCode, chatId, unseen);

      yield* TestClock.adjust("5 minutes");
      yield* Fixture.next(events, listing(unseen));
      // A job waits until the worker decided; one that slept removed its VM before answering.
      yield* Fixture.caughtUp(chatId);
      assert.deepEqual(runner.removedChats, []);
      assert.isTrue(runner.chats.has(chatId));

      if (blocker === "compaction") {
        // Once the compaction leaves, a running shell still keeps the VM alive.
        FakeOpenCode.emptyInbox(openCode, chatId);
        const shell = FakeOpenCode.runningShell(openCode, chatId);
        const child = FakeOpenCode.chatSubagent(openCode, chatId);
        FakeOpenCode.endTurn(openCode, chatId, child);
        yield* TestClock.adjust("5 minutes");
        yield* Fixture.next(events, listing(child));
        yield* Fixture.caughtUp(chatId);
        assert.deepEqual(runner.removedChats, []);
        yield* chats.stop({ chatId }, alice);
        yield* Fixture.caughtUp(chatId);
        assert.include(openCode.removedShells, `${chatId}:${shell}`);
      }
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});

describe("a chat whose VM the runner refused", () => {
  const refused = Effect.gen(function* () {
    const { chats, chatId } = yield* setup;
    const events = yield* Fixture.follow(chatId, alice);
    runner.refuse = "The agent's image is missing.";
    yield* chats.send({ chatId, inputId: "input-1", text: "Hi.", attachments: [] }, alice);
    yield* Fixture.next(events, hasStatus("failed"));
    return { chats, chatId, events };
  });

  it.effect("fails, and tries again only at its next message", () =>
    Effect.gen(function* () {
      const { chatId, events } = yield* refused;
      // A refusal would only repeat, so nothing starts the VM again by itself.
      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(runner.starts, [chatId]);

      runner.refuse = null;
      yield* Fixture.deliver(events, { chatId, inputId: "input-2", text: "Still there?" }, alice);
      assert.deepEqual(runner.starts, [chatId, chatId]);
      assert.deepEqual(
        openCode.prompts.map((prompt) => prompt.id),
        [inputMessageId(chatId, "input-1"), inputMessageId(chatId, "input-2")],
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("cancels at a stop the input sent before it, and delivers the one sent after it", () =>
    Effect.gen(function* () {
      const { chats, chatId, events } = yield* refused;
      yield* chats.stop({ chatId }, alice);
      runner.refuse = null;
      yield* Fixture.deliver(
        events,
        { chatId, inputId: "input-2", text: "Zip them instead." },
        alice,
      );
      assert.deepEqual(
        openCode.prompts.map((prompt) => prompt.id),
        [inputMessageId(chatId, "input-2")],
      );
      assert.equal(yield* inputState(chatId, "input-1"), "cancelled");
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("has the sweep carry out a stop saved without a wake", () =>
    Effect.gen(function* () {
      const { chatId, events } = yield* refused;
      runner.refuse = null;

      yield* (yield* ChatRepository.ChatRepository).requestStop(chatId);
      yield* TestClock.adjust("30 seconds");
      yield* Fixture.next(events, noInputs);
      assert.equal(yield* inputState(chatId, "input-1"), "cancelled");
      assert.isNull(yield* stopRequest(chatId));
      assert.deepEqual(runner.starts, [chatId]);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("tries again at the next start, which removes the chat VMs T45 keeps none for", () =>
    Effect.gen(function* () {
      const { chatId, events } = yield* refused;
      const chats = yield* ChatService;
      runner.refuse = null;
      runner.inventory = {
        isAvailable: true,
        reason: null,
        vms: [
          {
            vmId: "wiped",
            state: "running",
            connections: 0,
            lastActiveAt: DateTime.makeUnsafe("2026-10-23T09:00:00Z"),
          },
        ],
      };
      yield* chats.start(Fixture.stepHooks);
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-1"), "settled"));
      assert.deepEqual(runner.starts, [chatId, chatId]);
      assert.deepEqual(runner.removedChats, ["wiped"]);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("is left alone by the sweep until a new input lifts it", () =>
    Effect.gen(function* () {
      const { chatId, events } = yield* refused;
      yield* TestClock.adjust("30 seconds");

      runner.refuse = null;
      yield* writeInput(chatId, "input-2", "Still there?");
      yield* TestClock.adjust("30 seconds");
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-2"), "settled"));
      assert.deepEqual(runner.starts, [chatId, chatId]);
      assert.deepEqual(
        openCode.prompts.map((prompt) => prompt.id),
        [inputMessageId(chatId, "input-1"), inputMessageId(chatId, "input-2")],
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});

describe("a chat whose VM is lost", () => {
  const working = Effect.gen(function* () {
    const { chats, chatId, root } = yield* setup;
    const events = yield* Fixture.follow(chatId, alice);
    yield* Fixture.deliver(
      events,
      { chatId, inputId: "input-1", text: "Sum the receipts." },
      alice,
    );
    const done = FakeOpenCode.answerText(openCode, chatId, "Started.");
    runner.workspaces.set(chatId, new Uint8Array([7, 7, 7]));
    const idle = FakeOpenCode.finishTurn(openCode, chatId);
    yield* Fixture.next(events, Fixture.showing(done, "settled"));
    const unfinished = yield* midStep(events, chatId);
    return {
      chats,
      chatId,
      root,
      events,
      first: inputMessageId(chatId, "input-1"),
      done,
      idle,
      unfinished,
    };
  });

  it.effect(
    "restores the chat into a new boot: its history and workspace, inputs it never delivered, and a note on the step it lost",
    () =>
      Effect.gen(function* () {
        const { chats, chatId, root, events, first, done, idle, unfinished } = yield* working;
        // An input waits behind the agent's step when the VM dies.
        FakeOpenCode.hold(openCode, chatId, true);
        yield* chats.send(
          { chatId, inputId: "input-2", text: "Then email it.", attachments: [] },
          alice,
        );
        yield* chats.send(
          { chatId, inputId: "input-3", text: "Never mind.", attachments: [] },
          alice,
        );
        yield* chats.cancel({ chatId, inputId: "input-3" }, alice);
        const bootBefore = runner.boots.get(chatId);
        crashVm(chatId);

        // The unfinished step is lost; the rest comes back in the new boot.
        yield* Fixture.next(events, Fixture.showing(unfinished, "lost"));
        const second = inputMessageId(chatId, "input-2");
        yield* Fixture.next(events, Fixture.showing(second, "settled"));
        const boot = runner.boots.get(chatId);
        assert.isDefined(boot);
        assert.notEqual(boot, bootBefore);
        const note = noteMessageId(chatId, "restore", boot!);
        assert.deepEqual(openCode.imports.get(`${chatId}:${root}`), [first, done, idle, note]);
        assert.deepEqual(runner.workspaces.get(chatId), new Uint8Array([7, 7, 7]));
        const restored = openCode.sessions.get(chatId);
        const noteText = restored?.items.find((item) => item.id === note)?.text;
        assert.include(String(noteText), "interrupted");
        assert.deepEqual(
          restored?.items.filter((item) => item.type === "user").map((item) => item.id),
          [first, second],
        );
        // The cancelled input never reaches the new boot.
        assert.isFalse(
          restored?.items.some((item) => item.id === inputMessageId(chatId, "input-3")),
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("keeps its note on what the VM was doing, even while restoring can't finish", () =>
    Effect.gen(function* () {
      const { chatId, events, unfinished } = yield* working;
      // The VM dies, and its replacement can't take the workspace back, so nothing is imported.
      runner.downFor.add("putChatWorkspace");
      crashVm(chatId);
      const lost = yield* Fixture.next(events, Fixture.showing(unfinished, "lost"));
      const note = lost.messages.find((each) => isNoteOf(chatId, "restore", each.message.id));
      assert.equal(note?.state, "settled");
      assert.include(
        note?.message.type === "synthetic" ? note.message.text : "",
        "was interrupted before it finished",
      );
      assert.equal(openCode.imports.size, 0);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("tells the agent and members when a new boot can't take /work back", () =>
    Effect.gen(function* () {
      const { chatId, root } = yield* setup;
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "Sum it." }, alice);
      runner.workspaces.set(chatId, new Uint8Array([7, 7, 7]));
      FakeOpenCode.finishTurn(openCode, chatId);
      yield* Fixture.next(events, isIdle);

      // The VM dies, and its replacement can't unpack what was saved.
      runner.refuseUnpack = "tar exited with 2";
      crashVm(chatId);
      const noted = yield* Fixture.next(
        events,
        (event): event is Messages =>
          event._tag === "messages" &&
          event.messages.some((each) => isNoteOf(chatId, "workspace", each.message.id)),
      );
      const note = noted.messages.find((each) => isNoteOf(chatId, "workspace", each.message.id));
      assert.include(
        note?.message.type === "synthetic" ? note.message.text : "",
        "/work could not be put back",
      );
      yield* Fixture.deliver(events, { chatId, inputId: "input-2", text: "Go on." }, alice);
      assert.include(openCode.imports.get(`${chatId}:${root}`) ?? [], note?.message.id ?? "");
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("carries an automation's run on once when its sandbox went away mid-turn", () =>
    Effect.gen(function* () {
      Fixture.resetFakes();
      yield* Fixture.addUser(admin.userId, admin.role);
      const chats = yield* ChatService;
      const agentId = yield* Fixture.addAgent("Summarizer", { chat: false });
      const chatId = yield* chats.tasks.start(
        { type: "automation", automationId: AutomationId.make("fixture") },
        agentId,
        {
          title: "Weekly summary",
          input: { text: "Summarize the week.", attachments: [] },
        },
      );
      const initial = (yield* (yield* ChatRepository.ChatRepository).latestInput(chatId))!;
      const events = yield* Fixture.follow(chatId, admin);
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, initial.inputId)));

      const unfinished = yield* midStep(events, chatId);
      crashVm(chatId);
      yield* Fixture.next(events, Fixture.showing(unfinished, "lost"));
      yield* Fixture.next(events, telling(resumePrompt));
      const again = yield* midStep(events, chatId);
      crashVm(chatId);
      yield* Fixture.next(events, Fixture.showing(again, "lost"));
      yield* Fixture.next(events, hasStatus("interrupted"));
      assert.deepStrictEqual(yield* inputTexts(chatId), ["Summarize the week.", resumePrompt]);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});
