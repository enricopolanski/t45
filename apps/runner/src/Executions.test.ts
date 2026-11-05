import { assert, it } from "@effect/vitest";
import { type Session, SessionMessage } from "@opencode/client/effect";
import type { Execution, ExecutionEvent } from "@t45/contracts/resources/Runner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as FakeOpenCode from "./FakeOpenCode.testkit.ts";
import * as Fixture from "./Runner.testkit.ts";
import { SandboxError } from "./Sandbox.ts";

// Live clock: an execution batches OpenCode's events for a moment before it reads what they changed.
const ID = "exec-1";
const { ROOT } = Fixture;
const first = { id: SessionMessage.ID.make("msg_input1"), text: "Sum the receipts." };
const second = { id: SessionMessage.ID.make("msg_input2"), text: "Email it." };
const attachment = { "attachments/w2.txt": new Uint8Array([4, 2]) };
const MODEL = { providerID: "opencode-go", id: "test-model" };
const ALLOW = { action: "*", resource: "*", effect: "allow" };
const NO_QUESTIONS = { action: "question", resource: "*", effect: "deny" };

const setup = Effect.all({ runner: Fixture.Runner, vms: FakeOpenCode.Vms });

const start = (execution: Execution) =>
  Effect.gen(function* () {
    const runner = yield* Fixture.Runner;
    return yield* runner.run({ id: ID, execution }).pipe(Stream.toQueue({ capacity: "unbounded" }));
  });

const next = <A extends ExecutionEvent, E>(
  events: Queue.Dequeue<ExecutionEvent, E>,
  matches: (event: ExecutionEvent) => event is A,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events).pipe(Effect.orDie);
      if (matches(event)) return event;
    }
  });

const is =
  <T extends ExecutionEvent["_tag"]>(tag: T) =>
  (event: ExecutionEvent): event is Extract<ExecutionEvent, { _tag: T }> =>
    event._tag === tag;

const showing =
  (id: string) =>
  (event: ExecutionEvent): event is Extract<ExecutionEvent, { _tag: "messages" }> =>
    event._tag === "messages" && event.messages.some((message) => message.id === id);

const asking =
  (count: number) =>
  (event: ExecutionEvent): event is Extract<ExecutionEvent, { _tag: "questions" }> =>
    event._tag === "questions" && event.forms.length === count;

/** What T45 keeps of a run: its last sessions, each with its messages as last seen. */
const saved = (events: Iterable<ExecutionEvent>): Execution["conversation"] => {
  let sessions: ReadonlyArray<Session.Info> = [];
  const messages = new Map<string, Map<string, SessionMessage.Info>>();
  for (const event of events) {
    if (event._tag === "sessions") sessions = event.sessions;
    if (event._tag !== "messages") continue;
    const kept = messages.get(event.sessionId) ?? new Map();
    for (const message of event.messages) kept.set(message.id, message);
    messages.set(event.sessionId, kept);
  }
  return sessions.map((info) => ({ info, messages: [...(messages.get(info.id)?.values() ?? [])] }));
};

/** A finished first run whose agent waited on a background subagent; returns what T45 saved. */
const converse = Effect.gen(function* () {
  const { runner, vms } = yield* setup;
  const run = yield* runner
    .run({ id: ID, execution: Fixture.execution({ inputs: [first] }) })
    .pipe(Stream.runCollect, Effect.forkChild);
  yield* FakeOpenCode.prompted(vms, first.id);
  const child = FakeOpenCode.backgroundSubagent(vms, ID);
  FakeOpenCode.reportSubagent(vms, ID, child);
  FakeOpenCode.finishTurn(vms, ID);
  const conversation = saved(yield* Fiber.join(run));
  const messages = conversation[0]?.messages.map((message) => message.id) ?? [];
  return { conversation, child, messages };
});

it.live(
  "runs in a fresh VM set up from the agent, streams the agent's work and finishes with /work, then removes the VM",
  () =>
    Effect.gen(function* () {
      const { vms } = yield* setup;
      const input = { ...first, metadata: { t45: { attachments: [] } } };
      const before = new Uint8Array([1, 1]);
      const after = new Uint8Array([7, 7, 7]);
      const execution = Fixture.execution({
        workspace: before,
        files: attachment,
        inputs: [input],
      });
      const events = yield* start(execution);
      const { sessions } = yield* next(events, is("sessions"));
      assert.deepEqual(
        sessions.map(({ id, title }) => [id, title]),
        [[ROOT, "Receipts"]],
      );
      yield* next(events, showing(input.id));
      const vm = FakeOpenCode.vm(vms, ID);
      const root = FakeOpenCode.root(vms, ID);
      assert.deepEqual(vm.agent, execution.agent);
      assert.deepEqual(vm.workspace, before);
      assert.deepEqual(Object.fromEntries(vm.files), attachment);
      assert.deepEqual([root.info.model, root.info.permissions], [MODEL, [ALLOW]]);
      assert.deepEqual(vms.prompts, [{ ...input, delivery: "queue" }]);

      FakeOpenCode.emit(vms, ID, "session.text.delta", {
        sessionID: ROOT,
        assistantMessageID: "msg_streaming",
        ordinal: 0,
        delta: "Fil",
      });
      assert.deepEqual(yield* next(events, is("delta")), {
        _tag: "delta",
        sessionId: ROOT,
        messageId: SessionMessage.ID.make("msg_streaming"),
        ordinal: 0,
        kind: "text",
        delta: "Fil",
      });

      vm.workspace = after;
      const reply = FakeOpenCode.answerText(vms, ID, "Filed.");
      FakeOpenCode.finishTurn(vms, ID);
      yield* next(events, showing(reply));
      assert.deepEqual(yield* next(events, is("finished")), {
        _tag: "finished",
        outcome: null,
        workspace: after,
      });
      yield* FakeOpenCode.removed(vms, ID);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live(
  "a follow-up imports the saved conversation parents first, prompts only its inputs, and ends failed with the root's turn",
  () =>
    Effect.gen(function* () {
      const { vms } = yield* setup;
      const { conversation, child, messages } = yield* converse;
      const events = yield* start(
        Fixture.execution({
          conversation,
          title: "Receipts, sent",
          questions: false,
          inputs: [second],
        }),
      );
      yield* next(events, showing(second.id));
      const [root, subagent] = FakeOpenCode.vm(vms, ID).sessions;
      assert.deepEqual(
        [root?.id, root?.info.title, root?.info.model, root?.info.permissions],
        [ROOT, "Receipts, sent", MODEL, [ALLOW, NO_QUESTIONS]],
      );
      assert.deepEqual(
        [subagent?.id, subagent?.info.parentID, subagent?.info.title, subagent?.info.permissions],
        [child, ROOT, "Research", [ALLOW, NO_QUESTIONS]],
      );
      assert.deepEqual(
        root?.items.map((item) => item.id),
        [...messages, second.id],
      );
      assert.deepEqual(
        vms.prompts.map((prompt) => prompt.id),
        [first.id, second.id],
      );
      FakeOpenCode.failTurn(vms, ID);
      assert.strictEqual((yield* next(events, is("finished"))).outcome, "failed");
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live.each(["crash", "hang"] as const)(
  "a VM lost to a %s starts over in a new VM, which imports and prompts again, and finishes",
  (loss) =>
    Effect.gen(function* () {
      const { vms } = yield* setup;
      const { conversation, messages } = yield* converse;
      const events = yield* start(Fixture.execution({ conversation, inputs: [second] }));
      yield* next(events, showing(second.id));
      if (loss === "crash") FakeOpenCode.crash(vms, ID);
      else {
        FakeOpenCode.hang(vms, ID);
        FakeOpenCode.answerText(vms, ID, "Sent.");
      }
      yield* next(events, is("restarted"));
      yield* next(events, showing(second.id));
      assert.lengthOf(vms.started, 3);
      assert.deepEqual(
        FakeOpenCode.root(vms, ID).items.map((item) => item.id),
        [...messages, second.id],
      );
      assert.deepEqual(
        vms.prompts.map((prompt) => prompt.id),
        [first.id, second.id, second.id],
      );
      FakeOpenCode.finishTurn(vms, ID);
      assert.isNull((yield* next(events, is("finished"))).outcome);
      yield* FakeOpenCode.removed(vms, ID);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live("fails when the sandbox refuses the VM, and removes it", () =>
  Effect.gen(function* () {
    const { runner, vms } = yield* setup;
    vms.starting = Effect.fail(
      new SandboxError({ operation: "start", cause: new Error("The image is missing.") }),
    );
    const exit = yield* runner
      .run({ id: ID, execution: Fixture.execution({ inputs: [first] }) })
      .pipe(Stream.runDrain, Effect.exit);
    assert.isTrue(Exit.hasDies(exit));
    assert.lengthOf(vms.started, 1);
    yield* FakeOpenCode.removed(vms, ID);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.live.each(["starts", "runs"] as const)(
  "ending the run call while the VM %s removes the VM",
  (phase) =>
    Effect.gen(function* () {
      const { runner, vms } = yield* setup;
      const entered = yield* Deferred.make<void>();
      if (phase === "starts") {
        vms.starting = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      }
      const run = yield* runner
        .run({ id: ID, execution: Fixture.execution({ inputs: [first] }) })
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* phase === "starts" ? Deferred.await(entered) : FakeOpenCode.prompted(vms, first.id);
      yield* Fiber.interrupt(run);
      assert.lengthOf(vms.started, 1);
      yield* FakeOpenCode.removed(vms, ID);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live("send writes the input's files and prompts it once, however often it is sent", () =>
  Effect.gen(function* () {
    const { runner, vms } = yield* setup;
    const events = yield* start(Fixture.execution({ inputs: [first] }));
    yield* next(events, showing(first.id));
    yield* runner.send({ id: ID, input: second, files: attachment });
    yield* runner.send({ id: ID, input: second, files: {} });
    yield* next(events, showing(second.id));
    assert.deepEqual(Object.fromEntries(FakeOpenCode.vm(vms, ID).files), attachment);
    FakeOpenCode.finishTurn(vms, ID);
    yield* next(events, is("finished"));
    assert.deepEqual(
      vms.prompts.map((prompt) => prompt.id),
      [first.id, second.id],
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.live("cancel takes a queued input back from the VM's inbox, so it is never delivered", () =>
  Effect.gen(function* () {
    const { runner, vms } = yield* setup;
    const events = yield* start(Fixture.execution({ inputs: [first] }));
    yield* next(events, showing(first.id));
    FakeOpenCode.hold(vms, ID, true);
    yield* runner.send({ id: ID, input: second, files: {} });
    yield* FakeOpenCode.prompted(vms, second.id);
    yield* runner.cancel({ id: ID, inputId: second.id });
    const root = FakeOpenCode.root(vms, ID);
    assert.deepEqual(root.inbox, []);
    FakeOpenCode.hold(vms, ID, false);
    FakeOpenCode.finishTurn(vms, ID);
    yield* next(events, is("finished"));
    assert.notInclude(
      root.items.map((item) => item.id),
      second.id,
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.live("a send that arrives after its input's cancel is ignored", () =>
  Effect.gen(function* () {
    const { runner, vms } = yield* setup;
    const events = yield* start(Fixture.execution({ inputs: [first] }));
    yield* next(events, showing(first.id));
    yield* runner.cancel({ id: ID, inputId: second.id });
    yield* runner.send({ id: ID, input: second, files: {} });
    FakeOpenCode.finishTurn(vms, ID);
    yield* next(events, is("finished"));
    assert.deepEqual(
      vms.prompts.map((prompt) => prompt.id),
      [first.id],
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.live(
  "answer writes its files and replies to the agent's question, dismiss cancels one, and neither reaches a run that isn't there",
  () =>
    Effect.gen(function* () {
      const { runner, vms } = yield* setup;
      const events = yield* start(Fixture.execution({ inputs: [first] }));
      yield* next(events, showing(first.id));
      const answered = FakeOpenCode.ask(vms, ID);
      yield* next(events, asking(1));
      const answer = { year: "2025" };
      yield* runner.answer({
        id: ID,
        sessionId: ROOT,
        formId: answered,
        answer,
        files: attachment,
      });
      assert.deepEqual(Object.fromEntries(FakeOpenCode.vm(vms, ID).files), attachment);
      assert.deepEqual(vms.replies.get(answered), answer);
      yield* next(events, asking(0));

      const dismissed = FakeOpenCode.ask(vms, ID);
      yield* next(events, asking(1));
      yield* runner.dismiss({ id: ID, sessionId: ROOT, formId: dismissed });
      yield* next(events, asking(0));
      assert.isFalse(vms.replies.has(dismissed));

      const elsewhere = { id: "exec-2", sessionId: ROOT, formId: dismissed };
      const gone = yield* runner.answer({ ...elsewhere, answer, files: {} }).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "QuestionGone");
      assert.strictEqual((yield* runner.dismiss(elsewhere).pipe(Effect.flip))._tag, "QuestionGone");
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live("captures past one page of OpenCode's messages at once", () =>
  Effect.gen(function* () {
    const { vms } = yield* setup;
    const events = yield* start(Fixture.execution({ inputs: [first] }));
    yield* next(events, showing(first.id));
    const replies = Array.from({ length: 201 }, (_, at) =>
      FakeOpenCode.answerText(vms, ID, `Line ${at}`),
    );
    const { messages } = yield* next(events, showing(replies[200] ?? ""));
    assert.include(
      messages.map((message) => message.id),
      replies[0],
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.live.each(["a shell runs", "a background subagent hasn't reported"] as const)(
  "keeps the VM while %s, and finishes once OpenCode is done",
  (blocker) =>
    Effect.gen(function* () {
      const { vms } = yield* setup;
      const events = yield* start(Fixture.execution({ inputs: [first] }));
      yield* next(events, showing(first.id));
      const shell = blocker === "a shell runs" ? FakeOpenCode.runningShell(vms, ID) : null;
      const child = shell === null ? FakeOpenCode.backgroundSubagent(vms, ID) : null;
      const idle = FakeOpenCode.finishTurn(vms, ID);
      // The root is read idle before OpenCode is asked whether anything else runs.
      yield* next(events, showing(idle));

      // Only an execution still running reads what the agent writes next.
      const last =
        shell === null
          ? FakeOpenCode.reportSubagent(vms, ID, child ?? "")
          : FakeOpenCode.answerText(vms, ID, "Built.");
      if (shell !== null) FakeOpenCode.exitShell(vms, ID, shell);
      yield* next(events, showing(last));
      yield* next(events, is("finished"));
    }).pipe(Effect.provide(Fixture.layer)),
);

it.live("sends a file the agent leaves in .t45/attached before the messages naming it", () =>
  Effect.gen(function* () {
    const { vms } = yield* setup;
    const events = yield* start(Fixture.execution({ inputs: [first] }));
    yield* next(events, showing(first.id));
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    FakeOpenCode.vm(vms, ID).files.set(".t45/attached/report.pdf", pdf);
    const reply = FakeOpenCode.answerText(vms, ID, "Attached report.pdf.");
    const naming = showing(reply);
    assert.deepEqual(
      yield* next(
        events,
        (event): event is ExecutionEvent => event._tag === "file" || naming(event),
      ),
      { _tag: "file", path: ".t45/attached/report.pdf", content: pdf },
    );
    yield* next(events, naming);
  }).pipe(Effect.provide(Fixture.layer)),
);
