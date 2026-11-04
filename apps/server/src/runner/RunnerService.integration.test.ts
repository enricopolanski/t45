import { assert, describe, it } from "@effect/vitest";
import { Form } from "@opencode/client/effect";
import type { ChatEvent, ChatSummary } from "@t45/contracts/resources/Chats";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { inputMessageId, rootSessionId } from "../chats/ChatIds.ts";
import * as ChatRepository from "../chats/ChatRepository.ts";
import { ChatService } from "../chats/ChatService.ts";
import { TaskService } from "../tasks/TaskService.ts";
import * as WorkflowService from "../workflows/WorkflowService.ts";
import * as Fixture from "../chats/Chats.testkit.ts";
import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";
import * as FakeRunner from "./FakeRunner.testkit.ts";

// Live clock: an execution batches OpenCode's events for a moment before it reads what they changed.
const { openCode, runner } = Fixture;
const alice = { userId: "user-alice", role: "member" } as const;
/** What the agent leaves in its VM's /work. */
const work = new Uint8Array([7, 7, 7]);

const hasStatus =
  (status: ChatSummary["status"]) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "chat" }> =>
    event._tag === "chat" && event.chat.status === status;

/** The chat's execution ended: its status is no longer running or waiting. */
const isEnded = (event: ChatEvent): event is Extract<ChatEvent, { _tag: "chat" }> =>
  event._tag === "chat" && event.chat.status !== "running" && event.chat.status !== "waiting";

const asking =
  (count: number) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "questions" }> =>
    event._tag === "questions" && event.questions.length === count;

const messageIds = (chatId: string, ...inputIds: ReadonlyArray<string>) =>
  inputIds.map((inputId) => inputMessageId(chatId, inputId));

/** The messages T45 last imported into the chat's root session. */
const imported = (chatId: string) => openCode.imports.get(`${chatId}:${rootSessionId(chatId)}`);

/** The messages T45 prompted, in order, across every VM. */
const promptIds = () => openCode.prompts.map((prompt) => prompt.id);

const setup = Effect.gen(function* () {
  Fixture.resetFakes();
  yield* Fixture.addUser(alice.userId);
  const agentId = yield* Fixture.addAgent("Clerk");
  const chatId = yield* Fixture.seedChat({
    id: Fixture.testChatId(1),
    ownerUserId: alice.userId,
    agentId,
  });
  const chats = yield* ChatService;
  const events = yield* Fixture.follow(chatId, alice);
  /** Sends an input and waits until members see the agent took it. */
  const deliver = (inputId: string, text: string) =>
    Fixture.deliver(events, { chatId, inputId, text }, alice);
  /** Waits until the chat's execution ends, for the status it ended with. */
  const ended = Fixture.next(events, isEnded).pipe(Effect.map((event) => event.chat.status));
  return {
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
    /**
     * Runs an input through an execution in which the agent replies and leaves `work` in /work,
     * until its VM is gone. Returns the reply's id and the idle message's.
     */
    converse: (inputId: string, text: string) =>
      Effect.gen(function* () {
        yield* deliver(inputId, text);
        runner.workspaces.set(chatId, work);
        const reply = FakeOpenCode.answerText(openCode, chatId, `Done: ${text}`);
        const idle = FakeOpenCode.finishTurn(openCode, chatId);
        assert.isNull(yield* ended);
        yield* FakeRunner.removed(runner, chatId);
        return [reply, idle] as const;
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
  it.live(
    "runs a send in a fresh VM set up from the agent, keeps the reply, then saves /work and removes the VM",
    () =>
      Effect.gen(function* () {
        const { chats, chatId, agentId, root, repository, events, ended } = yield* setup;
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

        const vm = runner.chats.get(chatId);
        assert.include(vm?.agent.instructions, "Use the policy.");
        assert.strictEqual(vm?.agent.permissions.network, "open");
        assert.deepEqual(vm?.agent.mcpServers, {
          docs: { type: "remote", url: "https://docs.example" },
        });
        assert.deepEqual(vm?.agent.files, { "policy.md": "The policy." });
        assert.deepEqual(openCode.sessions.get(chatId)?.model, {
          providerID: "opencode-go",
          id: "other-model",
        });
        assert.deepEqual(
          runner.chatFiles.get(`${chatId}:attachments/${file.id}`),
          new Uint8Array([4, 2]),
        );
        assert.deepEqual(
          openCode.prompts.map(({ id, metadata }) => ({ id, metadata })),
          [
            {
              id: inputMessageId(chatId, "input-1"),
              metadata: { t45: { text: "File it.", attachments: [file] } },
            },
          ],
        );

        FakeOpenCode.emit(openCode, chatId, "session.text.delta", {
          sessionID: root,
          assistantMessageID: "msg_streaming",
          ordinal: 0,
          delta: "Fil",
        });
        const delta = yield* Fixture.next(
          events,
          (event): event is Extract<ChatEvent, { _tag: "delta" }> => event._tag === "delta",
        );
        assert.deepEqual([delta.messageId, delta.delta], ["msg_streaming", "Fil"]);

        runner.workspaces.set(chatId, work);
        const reply = FakeOpenCode.answerText(openCode, chatId, "Filed.");
        FakeOpenCode.finishTurn(openCode, chatId);
        assert.deepEqual(
          Fixture.texts(yield* Fixture.next(events, Fixture.showing(reply, "settled"))),
          ["Filed."],
        );
        assert.isNull(yield* ended);
        yield* FakeRunner.removed(runner, chatId);
        assert.deepEqual(yield* repository.readWorkspace(chatId), work);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live(
    "runs a follow-up in a fresh VM with the saved /work and the committed conversation, prompting only the new input, and ends with the root's outcome",
    () =>
      Effect.gen(function* () {
        const { chatId, ended, deliver, converse } = yield* setup;
        const [reply, idle] = yield* converse("input-1", "Sum the receipts.");

        yield* deliver("input-2", "Email it.");
        assert.deepEqual(runner.starts, [chatId, chatId]);
        assert.deepEqual(runner.workspaces.get(chatId), work);
        assert.deepEqual(imported(chatId), [inputMessageId(chatId, "input-1"), reply, idle]);
        assert.deepEqual(promptIds(), messageIds(chatId, "input-1", "input-2"));
        FakeOpenCode.failTurn(openCode, chatId, "The provider refused the turn.");
        assert.equal(yield* ended, "failed");
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live.each(["the VM dies", "the VM stops answering"] as const)(
    "starts again in a fresh VM when %s, discarding what it wrote and sending its input again, never failing",
    (loss) =>
      Effect.gen(function* () {
        const { chatId, events, ended, deliver, converse } = yield* setup;
        const [reply, idle] = yield* converse("input-1", "Sum the receipts.");
        yield* deliver("input-2", "Then email it.");
        const partial = FakeOpenCode.answerText(openCode, chatId, "Emailing");
        yield* Fixture.next(events, Fixture.showing(partial, "settled"));
        if (loss === "the VM dies") FakeOpenCode.crash(openCode, chatId);
        else {
          // Its event stream stays open, so T45 finds out when it next reads.
          FakeOpenCode.hang(openCode, chatId);
          FakeOpenCode.answerText(openCode, chatId, "Sent.");
        }

        const shown = (yield* Fixture.next(events, Fixture.isSnapshot)).messages.map(
          (each) => each.message.id,
        );
        assert.include(shown, reply);
        assert.notInclude(shown, partial);
        yield* Fixture.next(events, Fixture.showing(inputMessageId(chatId, "input-2"), "settled"));
        assert.deepEqual(imported(chatId), [inputMessageId(chatId, "input-1"), reply, idle]);
        assert.deepEqual(promptIds(), messageIds(chatId, "input-1", "input-2", "input-2"));
        FakeOpenCode.finishTurn(openCode, chatId);
        assert.isNull(yield* ended);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live("fails when the runner refuses the VM, and sends every input at the next send", () =>
    Effect.gen(function* () {
      const { chatId, ended, send, deliver } = yield* setup;
      runner.refuse = "The agent's image is missing.";
      yield* send("input-1", "Hi.");
      assert.equal(yield* ended, "failed");

      runner.refuse = null;
      yield* deliver("input-2", "Still there?");
      assert.deepEqual(runner.starts, [chatId, chatId]);
      assert.deepEqual(promptIds(), messageIds(chatId, "input-1", "input-2"));
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live(
    "stops by removing the VM and discarding what it wrote, and the next execution sends the input again",
    () =>
      Effect.gen(function* () {
        const { chats, chatId, events, ended, deliver } = yield* setup;
        yield* deliver("input-1", "Sort the files.");
        const unfinished = FakeOpenCode.answerText(openCode, chatId, "Sorting", {
          streaming: true,
        });
        yield* Fixture.next(events, Fixture.showing(unfinished, "live"));

        yield* chats.stop({ chatId }, alice);
        assert.isFalse(runner.chats.has(chatId));
        const { messages, inputs } = yield* Fixture.next(events, Fixture.isSnapshot);
        assert.deepEqual(messages, []);
        assert.deepEqual(
          inputs.map((input) => input.inputId),
          ["input-1"],
        );
        assert.equal(yield* ended, "interrupted");

        yield* deliver("input-2", "Zip them too.");
        assert.deepEqual(promptIds(), messageIds(chatId, "input-1", "input-1", "input-2"));
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live(
    "cancels a queued input by taking it back from the VM, and refuses one OpenCode delivered",
    () =>
      Effect.gen(function* () {
        const { chats, chatId, repository, send, deliver } = yield* setup;
        yield* deliver("input-1", "Sort the files.");
        FakeOpenCode.hold(openCode, chatId, true);
        yield* send("input-2", "Then zip them.");
        yield* FakeOpenCode.prompted(openCode, inputMessageId(chatId, "input-2"));
        yield* chats.cancel({ chatId, inputId: "input-2" }, alice);
        assert.deepEqual(openCode.sessions.get(chatId)?.inbox, []);

        yield* send("input-3", "Then mail them.");
        yield* FakeOpenCode.prompted(openCode, inputMessageId(chatId, "input-3"));
        // The agent's turn ends and OpenCode delivers input-3 before T45 reads it.
        FakeOpenCode.hold(openCode, chatId, false);
        assert.equal(
          yield* chats
            .cancel({ chatId, inputId: "input-3" }, alice)
            .pipe(Effect.flip, Effect.map(Fixture.failureOf)),
          "already_taken",
        );
        assert.deepEqual(
          (yield* repository.inputs(chatId)).map((input) => input.inputId),
          ["input-1", "input-3"],
        );
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live(
    "waits on a question and answers it in the VM with its files, and no answer reaches a chat without a VM",
    () =>
      Effect.gen(function* () {
        const { chats, chatId, root, repository, events, ended, deliver } = yield* setup;
        yield* deliver("input-1", "File my taxes.");
        const formId = Form.ID.make(FakeOpenCode.ask(openCode, chatId));
        yield* Fixture.next(events, asking(1));
        yield* Fixture.next(events, hasStatus("waiting"));

        const file = yield* upload;
        const answer = (attachments: Record<string, ReadonlyArray<typeof file>>) =>
          chats.answer(
            { chatId, sessionId: root, formId, answers: { year: "2025" }, attachments },
            alice,
          );
        yield* answer({ year: [file] });
        const answered = String(openCode.formReplies.get(`${chatId}:${formId}`)?.year);
        assert.include(answered, "2025");
        assert.include(answered, `/work/attachments/${file.id}`);
        assert.deepEqual(
          runner.chatFiles.get(`${chatId}:attachments/${file.id}`),
          new Uint8Array([4, 2]),
        );
        yield* Fixture.next(events, asking(0));
        yield* Fixture.next(events, hasStatus("running"));

        FakeOpenCode.finishTurn(openCode, chatId);
        assert.isNull(yield* ended);
        yield* FakeRunner.removed(runner, chatId);
        const form = { id: formId, sessionID: root, title: "Which year?" };
        yield* repository.setQuestions(
          chatId,
          [Form.Info.make({ ...form, fields: [{ key: "year", type: "string" }] })],
          DateTime.formatIso(yield* DateTime.now),
        );
        assert.equal(
          yield* answer({}).pipe(Effect.flip, Effect.map(Fixture.failureOf)),
          "question_gone",
        );
        assert.deepEqual(runner.starts, [chatId]);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );

  it.live.each(["a shell runs", "a background subagent hasn't reported"] as const)(
    "keeps the VM while %s, and removes it once OpenCode is done",
    (blocker) =>
      Effect.gen(function* () {
        const { chatId, events, ended, deliver } = yield* setup;
        yield* deliver("input-1", "Build it.");
        const shell =
          blocker === "a shell runs" ? FakeOpenCode.runningShell(openCode, chatId) : null;
        const child = shell === null ? FakeOpenCode.backgroundSubagent(openCode, chatId) : null;
        const idle = FakeOpenCode.finishTurn(openCode, chatId);
        // The root is read idle before OpenCode is asked whether anything else runs.
        yield* Fixture.next(events, Fixture.showing(idle, "settled"));

        // Only an execution still running reads what the agent writes next.
        const last =
          shell === null
            ? FakeOpenCode.reportSubagent(openCode, chatId, child ?? "")
            : FakeOpenCode.answerText(openCode, chatId, "Built.");
        if (shell !== null) FakeOpenCode.exitShell(openCode, chatId, shell);
        yield* Fixture.next(events, Fixture.showing(last, "settled"));
        assert.isNull(yield* ended);
        yield* FakeRunner.removed(runner, chatId);
      }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});

describe("a server start", () => {
  it.live("runs again each execution owed", () =>
    Effect.gen(function* () {
      const { chatId, repository } = yield* setup;
      const at = DateTime.formatIso(yield* DateTime.now);
      // As an earlier process left it: an input saved and its execution owed.
      yield* repository.addInput(chatId, {
        inputId: "input-1",
        payload: { text: "Sort the files.", attachments: [] },
        at,
      });
      yield* repository.markRunning(chatId, at);

      yield* Layer.build(
        Layer.fresh(
          WorkflowService.layer.pipe(
            Layer.provideMerge(TaskService.layer),
            Layer.provideMerge(ChatService.layer),
          ),
        ),
      );
      yield* FakeOpenCode.prompted(openCode, inputMessageId(chatId, "input-1"));
      assert.deepEqual(runner.starts, [chatId]);
    }).pipe(Effect.scoped, Effect.provide(Fixture.layer)),
  );
});
