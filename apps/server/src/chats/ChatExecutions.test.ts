import { assert, describe, it } from "@effect/vitest";
import { SessionMessage } from "@opencode/schema/session-message";
import type { ChatEvent } from "@t45/contracts/resources/Chats";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { FakeRunner } from "../runner/FakeRunner.testkit.ts";
import * as WorkflowService from "../workflows/WorkflowService.ts";
import { inputMessageId, rootSessionId } from "./ChatIds.ts";
import * as ChatRepository from "./ChatRepository.ts";
import { ChatService } from "./ChatService.ts";
import * as Fixture from "./Chats.testkit.ts";

const alice = { userId: "user-alice", role: "member" } as const;
/** The disk an execution leaves. */
const disk = new Uint8Array([7, 7, 7]);

const asking = (event: ChatEvent): event is Extract<ChatEvent, { _tag: "questions" }> =>
  event._tag === "questions" && event.questions.length === 1;

const messageIds = (chatId: string, ...inputIds: ReadonlyArray<string>) =>
  inputIds.map((inputId) => inputMessageId(chatId, inputId));

const setup = Effect.gen(function* () {
  yield* Fixture.addUser(alice.userId);
  const agentId = yield* Fixture.addAgent("Clerk");
  const chatId = yield* Fixture.seedChat({
    id: Fixture.testChatId(1),
    ownerUserId: alice.userId,
    agentId,
  });
  const runner = yield* FakeRunner;
  const chats = yield* ChatService;
  const events = yield* Fixture.follow(chatId, alice);
  /** Sends an input and waits until members see the agent took it. */
  const deliver = (inputId: string, text: string) =>
    Fixture.deliver(events, { chatId, inputId, text }, alice);
  /** Waits until the chat's execution ends, for the status it ended with. */
  const ended = Fixture.next(events, Fixture.isEnded).pipe(
    Effect.map((event) => event.chat.status),
  );
  return {
    runner,
    chats,
    chatId,
    agentId,
    root: rootSessionId(chatId),
    repository: yield* ChatRepository.ChatRepository,
    events,
    ended,
    deliver,
    send: (inputId: string, text: string) =>
      chats.send({ chatId, inputId, text, attachments: [] }, alice),
    /** Runs an input through an execution in which the agent replies and leaves `disk`; returns the reply's id. */
    converse: (inputId: string, text: string) =>
      Effect.gen(function* () {
        yield* deliver(inputId, text);
        const reply = runner.reply(chatId, `Done: ${text}`);
        runner.finish(chatId, { disk });
        assert.isNull(yield* ended);
        return reply;
      }),
  };
});

const upload = Effect.gen(function* () {
  const files = yield* AttachmentRepository;
  const { id } = yield* files.upload(
    { type: "file", name: "w2.txt", mimeType: "text/plain", sizeBytes: 2 },
    alice.userId,
    Stream.make(new Uint8Array([4, 2])),
  );
  return { type: "file", id, name: "w2.txt", mimeType: "text/plain", sizeBytes: 2 } as const;
});

describe("a chat's execution", () => {
  it.effect(
    "runs a send with the agent's setup and the input's files, shows members the agent's work, then saves the disk",
    () =>
      Effect.gen(function* () {
        const { runner, chats, chatId, agentId, root, repository, events, ended } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agents SET instructions = 'Use the policy.',
          model = 'opencode-go/other-model', network = 'open',
          mcp_servers = '{"docs":{"type":"remote","url":"https://docs.example"}}',
          files = '{"policy.md":"The policy."}'
          WHERE id = ${agentId}`;
        const file = yield* upload;
        yield* chats.send(
          { chatId, inputId: "input-1", text: "File it.", attachments: [file] },
          alice,
        );
        yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-1"), "settled"));

        const request = runner.executions[0]!;
        assert.deepEqual(request.agent, {
          instructions: "Use the policy.",
          model: "opencode-go/other-model",
          mcpServers: { docs: { type: "remote", url: "https://docs.example" } },
          permissions: { network: "open" },
          files: { "policy.md": "The policy." },
          tools: {},
          skills: [],
        });
        assert.deepEqual(
          [request.rootId, request.title, request.allowQuestions, request.disk],
          [root, chatId, true, null],
        );
        assert.deepEqual(request.files, { [`attachments/${file.id}`]: new Uint8Array([4, 2]) });
        assert.deepEqual(
          request.messages.map(({ id, metadata }) => ({ id, metadata })),
          [
            {
              id: inputMessageId(chatId, "input-1"),
              metadata: { t45: { text: "File it.", attachments: [file] } },
            },
          ],
        );

        runner.emit(chatId, {
          _tag: "delta",
          sessionId: root,
          messageId: SessionMessage.ID.make("msg_streaming"),
          ordinal: 0,
          kind: "text",
          delta: "Fil",
        });
        const delta = yield* Fixture.next(
          events,
          (event): event is Extract<ChatEvent, { _tag: "delta" }> => event._tag === "delta",
        );
        assert.deepEqual([delta.messageId, delta.delta], ["msg_streaming", "Fil"]);

        const reply = runner.reply(chatId, "Filed.");
        assert.deepEqual(
          Fixture.texts(yield* Fixture.next(events, Fixture.showing(reply, "settled"))),
          ["Filed."],
        );
        runner.finish(chatId, { disk });
        assert.isNull(yield* ended);
        assert.deepEqual(yield* repository.readDisk(chatId), disk);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "runs a follow-up on the saved disk, sending only the new input, and ends with the execution's outcome",
    () =>
      Effect.gen(function* () {
        const { runner, chatId, ended, deliver, converse } = yield* setup;
        yield* converse("input-1", "Sum the receipts.");

        yield* deliver("input-2", "Email it.");
        const request = runner.executions[1]!;
        assert.deepEqual(request.disk, disk);
        assert.deepEqual(
          request.messages.map((message) => message.id),
          messageIds(chatId, "input-2"),
        );
        runner.finish(chatId, { outcome: "failed" });
        assert.equal(yield* ended, "failed");
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "retains a failed execution's output and saved disk, clears questions, and ends without retrying",
    () =>
      Effect.gen(function* () {
        const { runner, chats, chatId, root, repository, events, ended, deliver, converse } =
          yield* setup;
        const reply = yield* converse("input-1", "Sum the receipts.");
        yield* deliver("input-2", "Then email it.");
        const partial = runner.reply(chatId, "Emailing", { streaming: true });
        yield* Fixture.next(events, Fixture.showing(partial, "live"));
        runner.ask(chatId);
        yield* Fixture.next(events, asking);
        runner.fail(chatId);

        yield* Fixture.next(events, Fixture.showing(partial, "settled"));
        assert.equal(yield* ended, "failed");
        assert.equal(
          (yield* chats.message(
            { chatId, sessionId: root, messageId: SessionMessage.ID.make(partial) },
            alice,
          )).state,
          "settled",
        );
        const rows = yield* repository.page(chatId, rootSessionId(chatId), null, 50);
        assert.includeMembers(
          rows.rows.map((row) => row.messageId),
          [reply, partial],
        );
        assert.deepEqual(yield* repository.questions(chatId), []);
        assert.deepEqual(
          (yield* repository.executionInputs(chatId)).map((input) => input.inputId),
          ["input-2"],
        );
        yield* runner.ended(chatId);
        assert.lengthOf(runner.executions, 2);
        assert.deepEqual(yield* repository.readDisk(chatId), disk);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("fails when its execution fails, and runs every pending input at the next send", () =>
    Effect.gen(function* () {
      const { runner, chatId, ended, send, deliver } = yield* setup;
      runner.refuse = "The agent's image is missing.";
      yield* send("input-1", "Hi.");
      assert.equal(yield* ended, "failed");

      runner.refuse = null;
      yield* deliver("input-2", "Still there?");
      assert.deepEqual(
        runner.executions.map((request) => request.messages.map((message) => message.id)),
        [messageIds(chatId, "input-1"), messageIds(chatId, "input-1", "input-2")],
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "stops its execution while retaining its output, and resends inputs missing from the saved disk",
    () =>
      Effect.gen(function* () {
        const { runner, chats, chatId, repository, events, ended, deliver } = yield* setup;
        yield* deliver("input-1", "Sort the files.");
        const unfinished = runner.reply(chatId, "Sorting", { streaming: true });
        yield* Fixture.next(events, Fixture.showing(unfinished, "live"));

        yield* chats.stop({ chatId }, alice);
        yield* Fixture.next(events, Fixture.showing(unfinished, "settled"));
        assert.equal(yield* ended, "interrupted");
        yield* runner.ended(chatId);
        assert.isNotNull(yield* repository.message(chatId, rootSessionId(chatId), unfinished));
        assert.isNotEmpty(yield* repository.sessions(chatId));
        assert.deepEqual(
          (yield* repository.executionInputs(chatId)).map((input) => input.inputId),
          ["input-1"],
        );

        yield* deliver("input-2", "Zip them too.");
        assert.equal(
          (yield* chats.message(
            {
              chatId,
              sessionId: rootSessionId(chatId),
              messageId: SessionMessage.ID.make(unfinished),
            },
            alice,
          )).state,
          "settled",
        );
        assert.deepEqual(
          runner.executions.at(-1)?.messages.map((message) => message.id),
          messageIds(chatId, "input-1", "input-2"),
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect(
    "sends a follow-up to its execution, and cancels it by having the runner withdraw it",
    () =>
      Effect.gen(function* () {
        const { runner, chats, chatId, root, repository, send, deliver } = yield* setup;
        yield* deliver("input-1", "Sort the files.");
        runner.hold = true;
        yield* send("input-2", "Then zip them.");
        assert.include(
          runner.sends.map(({ message }) => message.id),
          inputMessageId(chatId, "input-2"),
        );

        yield* chats.cancel({ chatId, inputId: "input-2" }, alice);
        assert.deepEqual(runner.cancels, [
          { rootId: root, messageId: inputMessageId(chatId, "input-2") },
        ]);
        assert.isNull(yield* repository.input(chatId, "input-2"));
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.effect("shows the agent's question and answers it with the files the answer names", () =>
    Effect.gen(function* () {
      const { runner, chats, chatId, root, events, deliver } = yield* setup;
      yield* deliver("input-1", "File my taxes.");
      const formId = runner.ask(chatId);
      yield* Fixture.next(events, asking);

      const file = yield* upload;
      yield* chats.answer(
        {
          chatId,
          sessionId: root,
          formId,
          answers: { year: "2025" },
          attachments: { year: [file] },
        },
        alice,
      );
      const [answered] = runner.answers;
      assert.deepEqual(
        [answered?.rootId, answered?.sessionId, answered?.formId, answered?.files],
        [root, root, formId, { [`attachments/${file.id}`]: new Uint8Array([4, 2]) }],
      );
      const year = String(answered?.answer["year"]);
      assert.include(year, "2025");
      assert.include(year, `attachments/${file.id}`);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});

describe("a server start", () => {
  it.effect("runs again each execution owed", () =>
    Effect.gen(function* () {
      const { runner, chatId, repository } = yield* setup;
      const at = DateTime.formatIso(yield* DateTime.now);
      // As an earlier process left it: an input saved and its execution owed.
      yield* repository.addInput(chatId, {
        inputId: "input-1",
        payload: { text: "Sort the files.", attachments: [] },
        at,
      });
      yield* repository.markRunning(chatId, at);

      const started = yield* Layer.build(
        Layer.fresh(WorkflowService.layer.pipe(Layer.provideMerge(ChatService.layer))),
      );
      const events = yield* Fixture.follow(chatId, alice).pipe(Effect.provide(started));
      yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-1"), "settled"));
      assert.deepEqual(
        runner.executions.map(({ rootId }) => rootId),
        [rootSessionId(chatId)],
      );
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});
