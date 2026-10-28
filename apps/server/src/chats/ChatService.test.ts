import type { Agent } from "@t45/contracts/models/Agent";
import { AutomationId } from "@t45/contracts/models/Automation";
import { assert, describe, it } from "@effect/vitest";
import { Form, SessionMessage } from "@opencode/client/effect";
import type { Refused } from "@t45/contracts/models/Chat";
import type { ChatMessage } from "@t45/contracts/resources/Chats";
import type { NotFound } from "@t45/contracts/resources/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import * as FakeOpenCode from "../runner/FakeOpenCode.testkit.ts";
import { ChatEvents } from "./ChatEvents.ts";
import { inputMessageId, rootSessionId } from "./ChatIds.ts";
import * as ChatRepository from "./ChatRepository.ts";
import * as Fixture from "./Chats.testkit.ts";
import { ChatService, type Member } from "./ChatService.ts";
import { TaskService } from "../tasks/TaskService.ts";

const { isSnapshot, testChatId } = Fixture;

const alice = { userId: "user-alice", role: "member" } as const;
const bob = { userId: "user-bob", role: "member" } as const;
const admin = { userId: "user-admin", role: "admin" } as const;

const setup = Effect.gen(function* () {
  Fixture.resetFakes();
  for (const user of [alice, bob, admin]) yield* Fixture.addUser(user.userId, user.role);
  const agentId = yield* Fixture.addAgent("Clerk");
  return {
    chats: yield* ChatService,
    tasks: yield* TaskService,
    repository: yield* ChatRepository.ChatRepository,
    agentId,
  };
});

const listed = (chats: ChatService["Service"], member: Member) =>
  chats.subscribe(member).pipe(
    Stream.runHead,
    Effect.map((list) => (list._tag === "Some" ? list.value.chats.map((chat) => chat.id) : [])),
  );

const outcomeOf = (effect: Effect.Effect<unknown, Refused | NotFound>) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catch((error) => Effect.succeed(Fixture.failureOf(error))),
  );

const typed = (text: string) => ({ text, attachments: [] });

const upload = (uploader: string, type: "file" | "image" = "file") =>
  Effect.gen(function* () {
    const files = yield* AttachmentRepository;
    const { id, name, mimeType, sizeBytes } = yield* files.upload(
      type === "file"
        ? { type, name: "receipt.txt", mimeType: "text/plain", sizeBytes: 3 }
        : { type, name: "shot.png", mimeType: "image/png", sizeBytes: 3 },
      uploader,
      Stream.make(new Uint8Array(3)),
    );
    return { type, id, name, mimeType, sizeBytes } as const;
  });

describe("chats", () => {
  it.effect(
    "starts a member's chat at its first message, once per id, and never again once deleted",
    () =>
      Effect.gen(function* () {
        const { chats, agentId, tasks } = yield* setup;
        Fixture.runner.down = true;
        const other = yield* Fixture.addAgent("Other");
        const chatId = testChatId(1);
        const said = { chatId, inputId: "input-1", text: "Hi", attachments: [] };
        const first = { ...said, agentId };
        yield* chats.send(first, alice);
        yield* chats.send(first, alice);
        assert.deepEqual(
          [
            yield* outcomeOf(chats.send({ ...first, inputId: "input-2", agentId: other }, alice)),
            yield* outcomeOf(chats.send({ ...first, inputId: "input-2" }, bob)),
            yield* outcomeOf(chats.send({ ...said, chatId: testChatId(2) }, alice)),
          ],
          ["id_taken", "NotFound", "NotFound"],
        );
        const automated = yield* tasks.start(
          { type: "automation", automationId: AutomationId.make("fixture") },
          agentId,
          {
            title: "Nightly",
            input: typed("Run it."),
          },
        );
        assert.deepEqual(yield* listed(chats, alice), [chatId]);
        assert.deepEqual(yield* listed(chats, bob), []);
        assert.deepEqual(yield* listed(chats, admin), []);
        assert.equal(
          yield* outcomeOf(chats.open({ chatId: automated }, admin).pipe(Stream.runDrain)),
          "NotFound",
        );

        yield* chats.delete({ chatId }, alice);
        assert.deepEqual(yield* listed(chats, alice), []);
        assert.deepEqual(
          [
            yield* outcomeOf(chats.send({ ...first, inputId: "input-3" }, alice)),
            yield* outcomeOf(chats.open({ chatId }, alice).pipe(Stream.runDrain)),
          ],
          ["NotFound", "NotFound"],
        );
      }).pipe(Effect.provide(Fixture.layer)),
  );

  it.effect(
    "refuses conversations with unavailable agents and keeps background tasks private",
    () =>
      Effect.gen(function* () {
        const { chats, repository, tasks } = yield* setup;
        Fixture.runner.down = true;
        const quiet = yield* Fixture.addAgent("Quiet", { chat: false, stepTools: true });
        const retired = yield* Fixture.addAgent("Retired", { status: "archived", stepTools: true });
        const first = (n: number, agentId: Agent["id"]) =>
          chats.send({ chatId: testChatId(n), agentId, inputId: "input-1", ...typed("Hi") }, alice);
        const startTask = (agentId: Agent["id"]) =>
          tasks.start({ type: "automation", automationId: AutomationId.make("fixture") }, agentId, {
            title: "Report · Read",
            input: typed("Read the report."),
          });
        assert.deepEqual(
          [
            yield* outcomeOf(first(1, quiet)),
            yield* outcomeOf(first(2, retired)),
            yield* outcomeOf(first(3, "agent-gone")),
            yield* outcomeOf(startTask(retired)),
            yield* outcomeOf(startTask("agent-ghost")),
          ],
          Array.from({ length: 5 }, () => "agent_unavailable"),
        );

        const chatId = yield* startTask(quiet);
        assert.equal(
          yield* outcomeOf(chats.send({ chatId, inputId: "steer-1", ...typed("Read it.") }, admin)),
          "NotFound",
        );
        assert.deepEqual(
          (yield* repository.openInputs(chatId)).map((input) => input.payload.text),
          ["Read the report."],
        );
      }).pipe(Effect.provide(Fixture.layer)),
  );

  it.effect(
    "saves an input before answering, once per id, and calls other content under that id a conflict",
    () =>
      Effect.gen(function* () {
        const { chats, repository, agentId } = yield* setup;
        // Nothing reaches a VM: the input waits, saved.
        Fixture.runner.down = true;
        const chatId = testChatId(1);
        const input = { chatId, agentId, inputId: "input-1", ...typed("What changed?") };
        yield* chats.send(input, alice);
        yield* chats.send(input, alice);
        assert.deepEqual(
          [
            yield* outcomeOf(chats.send({ ...input, text: "Something else" }, alice)),
            yield* outcomeOf(chats.send({ ...input, inputId: "input-2", text: " " }, alice)),
          ],
          ["input_conflict", "empty_input"],
        );
        const snapshot = yield* Fixture.next(yield* Fixture.follow(chatId, alice), isSnapshot);
        assert.deepEqual(
          snapshot.inputs.map((each) => [each.inputId, each.text]),
          [["input-1", "What changed?"]],
        );
        assert.equal(snapshot.chat.status, "running");

        // A cancelled input stays cancelled, however often its send is repeated.
        yield* chats.cancel({ chatId, inputId: "input-1" }, alice);
        yield* chats.send(input, alice);
        assert.equal((yield* repository.input(chatId, "input-1"))?.state, "cancelled");
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("lists and opens a chat with its agent's name, titled by its first message", () =>
    Effect.gen(function* () {
      const { chats, agentId } = yield* setup;
      Fixture.runner.down = true;
      const chatId = testChatId(1);
      yield* chats.send({ chatId, agentId, inputId: "input-1", ...typed("Hi") }, alice);
      const list = yield* chats.subscribe(alice).pipe(Stream.runHead);
      assert.deepEqual(
        list._tag === "Some"
          ? list.value.chats.map((chat) => [chat.id, chat.agentName, chat.title])
          : [],
        [[chatId, "Clerk", "Hi"]],
      );
      const opened = yield* Fixture.next(yield* Fixture.follow(chatId, alice), isSnapshot);
      assert.equal(opened.chat.agentName, "Clerk");
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("titles an untitled member chat from its first input, and keeps that or a rename", () =>
    Effect.gen(function* () {
      const { repository, agentId, chats, tasks } = yield* setup;
      const titleOf = (n: number) =>
        repository.get(testChatId(n)).pipe(Effect.map((chat) => chat?.title));
      const send = (inputId: string, text: string) =>
        chats.send(
          {
            chatId: testChatId(1),
            inputId,
            ...typed(text),
            agentId,
          },
          alice,
        );
      yield* send("input-1", "  Check the 2025 return once more  ");
      const titles = [yield* titleOf(1)];
      yield* send("input-2", "Anything else?");
      titles.push(yield* titleOf(1));
      yield* repository.rename(testChatId(1), "Taxes");
      yield* send("input-3", "Thanks.");
      titles.push(yield* titleOf(1));
      assert.deepEqual(titles, [
        "Check the 2025 return once more",
        "Check the 2025 return once more",
        "Taxes",
      ]);

      yield* chats.send(
        {
          chatId: testChatId(2),
          inputId: "input-1",
          text: "",
          attachments: [yield* upload(alice.userId, "image")],
          agentId,
        },
        alice,
      );
      const taskId = yield* tasks.start(
        { type: "automation", automationId: AutomationId.make("fixture") },
        agentId,
        {
          title: "Inbox digest",
          input: typed("Summarize the inbox."),
        },
      );
      assert.deepEqual(
        [yield* titleOf(2), (yield* repository.get(taskId))?.title],
        ["Image: shot.png", "Inbox digest"],
      );
    }).pipe(Effect.provide(Fixture.layerStore)),
  );

  it.effect(
    "deletes a chat for everyone at once, then its VM, files and copy, even after the runner was down",
    () =>
      Effect.gen(function* () {
        const { chats, agentId } = yield* setup;
        Fixture.runner.down = true;
        const chatId = testChatId(1);
        const files = yield* AttachmentRepository;
        const sent = yield* upload(alice.userId);
        yield* chats.send(
          { chatId, agentId, inputId: "input-1", text: "File it.", attachments: [sent] },
          alice,
        );
        yield* chats.delete({ chatId }, alice);
        assert.deepEqual(yield* listed(chats, alice), []);
        const path = files.path(sent.id) ?? "";
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isTrue(yield* fileSystem.exists(path));

        // Back up, the next start finishes the delete.
        Fixture.runner.down = false;
        yield* chats.start(Fixture.stepHooks);
        const sql = yield* SqlClient.SqlClient;
        assert.include(Fixture.runner.removedChats, chatId);
        assert.isFalse(yield* fileSystem.exists(path));
        assert.deepEqual(yield* sql`SELECT input_id FROM chat_inputs`, []);
        assert.deepEqual(yield* sql`SELECT cleanup_pending FROM chats`, [{ cleanup_pending: 0 }]);
      }).pipe(Effect.provide(Fixture.layer)),
  );

  it.effect(
    "a send or an answer naming another member's pending upload, or a file already sent to another chat, is file_unavailable and saves nothing",
    () =>
      Effect.gen(function* () {
        const { chats, repository, agentId } = yield* setup;
        Fixture.runner.down = true;
        const budget = testChatId(1);
        const taxes = yield* Fixture.seedChat({
          id: testChatId(2),
          ownerUserId: alice.userId,
          agentId,
        });
        const mine = yield* upload(alice.userId);
        const bobs = yield* upload(bob.userId);
        yield* chats.send(
          { chatId: budget, agentId, inputId: "input-1", text: "File it.", attachments: [mine] },
          alice,
        );
        const sessionId = rootSessionId(taxes);
        const formId = Form.ID.make("frm_year");
        yield* repository.setQuestions(
          taxes,
          [
            Form.Info.make({
              id: formId,
              sessionID: sessionId,
              title: "Which year?",
              fields: [{ key: "year", type: "string" }],
            }),
          ],
          "2026-10-23T09:00:00.000Z",
        );

        for (const file of [bobs, mine]) {
          assert.deepEqual(
            [
              yield* outcomeOf(
                chats.send(
                  { chatId: taxes, inputId: "input-2", text: "And this.", attachments: [file] },
                  alice,
                ),
              ),
              yield* outcomeOf(
                chats.answer(
                  {
                    chatId: taxes,
                    sessionId,
                    formId,
                    answers: { year: "2025" },
                    attachments: { year: [file] },
                  },
                  alice,
                ),
              ),
            ],
            ["file_unavailable", "file_unavailable"],
          );
        }
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT chat_id, input_id FROM chat_inputs`, [
          { chat_id: budget, input_id: "input-1" },
        ]);
        assert.deepEqual(yield* sql`SELECT chat_id, attachment_id FROM chat_attachments`, [
          { chat_id: budget, attachment_id: mine.id },
        ]);
      }).pipe(Effect.provide(Fixture.layer)),
  );

  it.effect(
    "leaves a refused post's chat, input and files unwritten while its caller's rows commit",
    () =>
      Effect.gen(function* () {
        const { agentId, chats } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const mine = yield* upload(alice.userId);
        const bobs = yield* upload(bob.userId);
        const kept = testChatId(1);
        const refused = testChatId(2);

        const reason = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Fixture.addUser("carol");
            yield* chats.send(
              {
                chatId: kept,
                inputId: "input-1",
                text: "Mine.",
                attachments: [mine],
                agentId,
              },
              alice,
            );
            return yield* outcomeOf(
              chats.send(
                {
                  chatId: refused,
                  inputId: "input-1",
                  text: "And Bob's.",
                  attachments: [mine, bobs],
                  agentId,
                },
                alice,
              ),
            );
          }),
        );

        assert.equal(reason, "file_unavailable");
        assert.deepEqual(yield* sql`SELECT id FROM users WHERE id = 'carol'`, [{ id: "carol" }]);
        assert.deepEqual(yield* sql`SELECT id FROM chats`, [{ id: kept }]);
        assert.deepEqual(yield* sql`SELECT chat_id, input_id FROM chat_inputs`, [
          { chat_id: kept, input_id: "input-1" },
        ]);
        assert.deepEqual(yield* sql`SELECT chat_id, attachment_id FROM chat_attachments`, [
          { chat_id: kept, attachment_id: mine.id },
        ]);
      }).pipe(Effect.provide(Fixture.layerStore)),
  );

  it.effect(
    "announces a post once its outermost transaction commits, and never one rolled back",
    () =>
      Effect.gen(function* () {
        const { agentId, chats } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const changes = yield* ChatEvents;
        const heard = yield* changes.subscribe(
          (change) => change.kind === "posted" || change.kind === "chat",
        );
        const queue = yield* Stream.toQueue(heard, { capacity: "unbounded" });
        const mark = (n: number) =>
          changes.publish({
            kind: "chat",
            chatId: testChatId(n),
          });
        const postTo = (n: number, text = "Hello.") =>
          chats.send(
            {
              chatId: testChatId(n),
              inputId: "input-1",
              ...typed(text),
              agentId,
            },
            alice,
          );

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* postTo(1);
            yield* sql.withTransaction(postTo(2));
            yield* mark(90);
          }),
        );
        const rolledBack = yield* sql
          .withTransaction(postTo(3).pipe(Effect.andThen(Effect.fail("rolled back" as const))))
          .pipe(Effect.flip);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql
              .withTransaction(postTo(4).pipe(Effect.andThen(Effect.fail("undone" as const))))
              .pipe(Effect.ignore);
            yield* postTo(5);
          }),
        );
        yield* mark(91);

        const order = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
          Queue.take(queue).pipe(
            Effect.orDie,
            Effect.map((change) =>
              change.kind === "missed" ? change.kind : `${change.kind} ${change.chatId}`,
            ),
          ),
        );
        assert.equal(rolledBack, "rolled back");
        assert.deepEqual(order, [
          `chat ${testChatId(90)}`,
          `posted ${testChatId(1)}`,
          `posted ${testChatId(2)}`,
          `posted ${testChatId(5)}`,
          `chat ${testChatId(91)}`,
        ]);
        assert.deepEqual(
          [yield* outcomeOf(postTo(3, "Other.")), yield* outcomeOf(postTo(4, "Other."))],
          ["ok", "ok"],
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layerStore)),
  );

  it.effect(
    "delivers an input once a user message under its id is captured, and not a message typed in the VM",
    () =>
      Effect.gen(function* () {
        const { repository, agentId, chats } = yield* setup;
        const chatId = testChatId(1);
        for (const inputId of ["brief", "plain"]) {
          yield* chats.send(
            {
              chatId,
              inputId,
              ...typed(inputId),
              agentId,
            },
            alice,
          );
        }
        const created = DateTime.makeUnsafe("2026-10-24T09:00:00.000Z");
        const captured = yield* repository.capture(chatId, rootSessionId(chatId), [
          { id: inputMessageId(chatId, "brief"), type: "user", text: "brief", time: { created } },
          {
            id: SessionMessage.ID.make("msg_typed_in_the_vm"),
            type: "user",
            text: "plain",
            time: { created },
          },
        ]);
        assert.isTrue(captured.inputsChanged);
        assert.deepEqual(
          [
            (yield* repository.input(chatId, "brief"))?.state,
            (yield* repository.input(chatId, "plain"))?.state,
          ],
          ["materialized", "waiting"],
        );
      }).pipe(Effect.provide(Fixture.layerStore)),
  );

  it.effect("sends a stream that fell far behind a fresh snapshot instead of what it missed", () =>
    Effect.gen(function* () {
      const { chats, agentId } = yield* setup;
      const chatId = yield* Fixture.seedChat({
        id: testChatId(1),
        ownerUserId: alice.userId,
        agentId,
      });
      const pull = yield* Stream.toPull(chats.open({ chatId }, alice));
      assert.isTrue(isSnapshot((yield* pull)[0]));

      // The member's browser stops reading while the agent streams on.
      const changes = yield* ChatEvents;
      for (let at = 0; at < 1_500; at++) {
        yield* changes.publish({
          kind: "delta",
          chatId,
          sessionId: rootSessionId(chatId),
          messageId: "msg_streaming",
          ordinal: 0,
          part: "text",
          delta: "x",
        });
      }
      yield* chats.rename({ chatId, title: "Taxes" }, alice);
      const [caughtUp] = yield* pull;
      assert.isTrue(isSnapshot(caughtUp));
      assert.equal(isSnapshot(caughtUp) ? caughtUp.chat.title : null, "Taxes");
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("reads a chat from T45's copy alone: in pages, long text cut, a message whole", () =>
    Effect.gen(function* () {
      const { chats, agentId } = yield* setup;
      const chatId = yield* Fixture.seedChat({
        id: testChatId(1),
        ownerUserId: alice.userId,
        agentId,
      });
      const root = rootSessionId(chatId);
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "Write a lot." }, alice);
      const long = FakeOpenCode.answerText(Fixture.openCode, chatId, "x".repeat(20_000));
      let last = long;
      // More than OpenCode capture's 200-message page, as well as T45's 50-message read page.
      for (let at = 0; at < 220; at++) {
        last = FakeOpenCode.answerText(Fixture.openCode, chatId, `Line ${String(at)}`);
      }
      const idle = FakeOpenCode.finishTurn(Fixture.openCode, chatId);
      yield* Fixture.next(events, Fixture.showing(last, "settled"));

      // With every VM gone, the chat still reads.
      Fixture.runner.down = true;
      FakeOpenCode.crash(Fixture.openCode, chatId);
      const snapshot = yield* Fixture.next(yield* Fixture.follow(chatId, alice), isSnapshot);
      assert.equal(snapshot.messages.length, 50);
      assert.isTrue(snapshot.hasEarlier);
      assert.equal(snapshot.messages.at(-1)?.message.id, idle);
      const oldest = snapshot.messages[0]!.message.id;
      const older: Array<ChatMessage> = [];
      let before = oldest;
      while (true) {
        const page = yield* chats.history({ chatId, sessionId: root, before }, alice);
        older.unshift(...page.messages);
        if (!page.hasEarlier) break;
        assert.isNotEmpty(page.messages);
        before = page.messages[0]!.message.id;
      }
      const cut = older.find((each) => each.message.id === long);
      assert.isTrue(cut?.isTruncated);
      const whole = yield* chats.message(
        { chatId, sessionId: root, messageId: SessionMessage.ID.make(long) },
        alice,
      );
      assert.isFalse(whole.isTruncated);
      assert.deepEqual(Fixture.texts({ messages: [whole] }), ["x".repeat(20_000)]);
      assert.equal(older.length + snapshot.messages.length, 223);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("fills a page by the size of its messages as reads send them", () =>
    Effect.gen(function* () {
      const { chats, agentId } = yield* setup;
      const chatId = yield* Fixture.seedChat({
        id: testChatId(1),
        ownerUserId: alice.userId,
        agentId,
      });
      const events = yield* Fixture.follow(chatId, alice);
      yield* Fixture.deliver(events, { chatId, inputId: "input-1", text: "Search it all." }, alice);
      // Results in many parts, each short enough that reads send it whole: about 400 KB apiece.
      const results = FakeOpenCode.answerText(Fixture.openCode, chatId, "x".repeat(4_000), {
        parts: 100,
      });
      const more = FakeOpenCode.answerText(Fixture.openCode, chatId, "y".repeat(4_000), {
        parts: 100,
      });
      const idle = FakeOpenCode.finishTurn(Fixture.openCode, chatId);
      yield* Fixture.next(events, Fixture.showing(idle, "settled"));

      const snapshot = yield* Fixture.next(yield* Fixture.follow(chatId, alice), isSnapshot);
      assert.deepEqual(
        snapshot.messages.map((each) => each.message.id),
        [more, idle],
      );
      assert.isTrue(snapshot.hasEarlier);
      const earlier = yield* chats.history(
        { chatId, sessionId: rootSessionId(chatId), before: SessionMessage.ID.make(more) },
        alice,
      );
      assert.equal(earlier.messages.at(-1)?.message.id, results);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});
