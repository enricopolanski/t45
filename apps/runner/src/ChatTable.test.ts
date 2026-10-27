import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ChatTable from "./ChatTable.ts";
import * as Fixture from "./Runner.testkit.ts";

const IDLE = "45 minutes";

const withTable = (overrides: Parameters<typeof Fixture.layerConfig>[0] = {}) => {
  const chats = Fixture.makeFakeChats();
  const layer = ChatTable.layer.pipe(
    Layer.provide(Fixture.layerFakeChats(chats)),
    Layer.provide(Fixture.layerConfig(overrides)),
  );
  return { chats, layer };
};

/** Why the effect failed: a refusal's reason, or another error's tag. */
const refusal = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("reason" in error ? String(error.reason) : error._tag)),
  );

it.effect("A chat starts once, however many ask at the same time, and keeps its boot", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const boots = yield* Effect.all(
      [
        table.ensure({ chatId: "chat-1", chat: Fixture.chat() }),
        table.ensure({ chatId: "chat-1", chat: Fixture.chat() }),
      ],
      { concurrency: "unbounded" },
    );
    const again = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    assert.deepStrictEqual(chats.started, ["chat-1"]);
    assert.deepStrictEqual(
      [...boots, again].map(({ bootId }) => bootId),
      ["boot-1", "boot-1", "boot-1"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("A VM that stopped answering is let go and booted anew at the next start", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const first = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.ensure({ chatId: "chat-2", chat: Fixture.chat() });
    chats.crashed.add("chat-1");
    chats.crashed.add("chat-2");
    const second = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.ensure({ chatId: "chat-2", chat: Fixture.chat() });
    assert.deepStrictEqual(chats.removed, ["chat-1", "chat-2"]);
    assert.deepStrictEqual(chats.started, ["chat-1", "chat-2", "chat-1", "chat-2"]);
    assert.deepStrictEqual([first.bootId, second.bootId], ["boot-1", "boot-3"]);
  }).pipe(Effect.provide(layer));
});

it.effect("A chat nothing is open to is removed after the idle time and boots anew", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });

    // T45's event stream holds the chat open past the idle time.
    const open = yield* Scope.make();
    const server = yield* table.connect("chat-1").pipe(Scope.provide(open));
    assert.strictEqual(Option.getOrThrow(server).url, "http://127.0.0.1:9");
    yield* TestClock.adjust("2 hours");
    yield* table.stopIdle;
    assert.deepStrictEqual(chats.removed, []);

    // Once it closes, the chat waits out the idle time before its VM is removed.
    yield* Scope.close(open, Exit.void);
    yield* TestClock.adjust("44 minutes");
    yield* table.stopIdle;
    assert.deepStrictEqual(chats.removed, []);
    yield* TestClock.adjust("1 minute");
    yield* table.stopIdle;
    assert.deepStrictEqual(chats.removed, ["chat-1"]);

    // A removed chat takes no requests until T45 starts it again, as a new boot.
    assert.isTrue(Option.isNone(yield* table.connect("chat-1").pipe(Effect.scoped)));
    const next = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    assert.deepStrictEqual(chats.started, ["chat-1", "chat-1"]);
    assert.strictEqual(next.bootId, "boot-2");
  }).pipe(Effect.provide(layer));
});

it.effect("After the idle time every VM is removed", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.ensure({ chatId: "chat-2", chat: Fixture.chat() });
    yield* TestClock.adjust(IDLE);
    yield* table.stopIdle;
    assert.deepStrictEqual(chats.removed, ["chat-1", "chat-2"]);
    assert.deepStrictEqual(
      (yield* table.inventory).vms.map(({ vmId, state }) => [vmId, state]),
      [
        ["chat-1", "stopped"],
        ["chat-2", "stopped"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("T45 removes a chat's VM, and starting the chat again boots a new one", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.remove("chat-1");
    assert.deepStrictEqual(chats.removed, ["chat-1"]);
    const next = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    assert.strictEqual(next.bootId, "boot-2");
  }).pipe(Effect.provide(layer));
});

it.effect("A VM that fails to start is let go, refused, and takes no place", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    chats.failStart = true;
    assert.strictEqual(
      yield* refusal(table.ensure({ chatId: "chat-1", chat: Fixture.chat() })),
      "The chat's sandbox could not start.",
    );
    assert.strictEqual(
      yield* refusal(table.ensure({ chatId: "chat-2", chat: Fixture.chat() })),
      "The chat's sandbox could not start.",
    );
    assert.deepStrictEqual(chats.removed, ["chat-1", "chat-2"]);
    chats.failStart = false;
    yield* table.ensure({ chatId: "chat-3", chat: Fixture.chat() });
    yield* table.ensure({ chatId: "chat-4", chat: Fixture.chat() });
  }).pipe(Effect.provide(layer));
});

it.effect("A start T45 stops waiting for still finishes, and its VM goes when idle", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    chats.hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)));
    const ensuring = yield* table
      .ensure({ chatId: "chat-1", chat: Fixture.chat() })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const dropping = yield* Fiber.interrupt(ensuring).pipe(Effect.forkChild);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(dropping);
    chats.hold = Effect.void;
    // The VM it made is running and known, so asking again finds it.
    assert.isTrue(Option.isSome(yield* table.connect("chat-1").pipe(Effect.scoped)));
    const boot = yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    assert.deepStrictEqual([chats.started, boot.bootId], [["chat-1"], "boot-1"]);
    yield* TestClock.adjust(IDLE);
    yield* table.stopIdle;
    assert.deepStrictEqual(chats.removed, ["chat-1"]);
  }).pipe(Effect.provide(layer));
});

it.effect("A VM that could not be removed stays listed, and is removed when T45 asks again", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.ensure({ chatId: "chat-2", chat: Fixture.chat() });
    chats.failRemove = true;
    const failed = yield* table.remove("chat-1").pipe(Effect.flip);
    assert.strictEqual(failed._tag, "SandboxError");
    yield* table.remove("chat-2").pipe(Effect.flip);
    // T45's start-up sweep still finds both to remove.
    assert.deepStrictEqual(
      (yield* table.inventory).vms.map(({ vmId, state }) => [vmId, state]),
      [
        ["chat-1", "stopped"],
        ["chat-2", "stopped"],
      ],
    );
    chats.failRemove = false;
    yield* table.remove("chat-1");
    yield* table.remove("chat-2");
    assert.deepStrictEqual(chats.removed, ["chat-1", "chat-2"]);
    assert.deepStrictEqual((yield* table.inventory).vms, []);
  }).pipe(Effect.provide(layer));
});

it.effect("Files go only into a running chat, up to an attachment's size", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const stored = "attachments/0f8e4a52-6c1d-4b7e-9a3f-2d5c8b1e7a40.txt";
    const file = (content: Uint8Array) => ({ chatId: "chat-1", path: stored, content });
    const text = new TextEncoder().encode("CU");
    assert.strictEqual(yield* refusal(table.writeFile(file(text))), "The chat isn't running.");
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.writeFile(file(text));
    assert.strictEqual(new TextDecoder().decode(chats.files.get(`chat-1:${stored}`)), "CU");
    yield* table.writeFile(file(new Uint8Array(ATTACHMENT_MAX_FILE_BYTES)));
    assert.strictEqual(
      yield* refusal(table.writeFile(file(new Uint8Array(ATTACHMENT_MAX_FILE_BYTES + 1)))),
      "The file is too large.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("A file goes nowhere but a stored attachment's name under attachments/", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const stored = "attachments/0f8e4a52-6c1d-4b7e-9a3f-2d5c8b1e7a40.pdf";
    const write = (path: string) =>
      table.writeFile({ chatId: "chat-1", path, content: new TextEncoder().encode("CU") });
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    for (const path of [
      "AGENTS.md",
      "opencode.json",
      ".opencode/skills/report/SKILL.md",
      "attachments/cu.txt",
      "attachments/../AGENTS.md",
      "attachments/0f8e4a52-6c1d-4b7e-9a3f-2d5c8b1e7a40.pdf/../../AGENTS.md",
      `/work/${stored}`,
    ]) {
      assert.strictEqual(yield* refusal(write(path)), "Files go only under attachments/.");
    }
    yield* write(stored);
    assert.deepStrictEqual([...chats.files.keys()], [`chat-1:${stored}`]);
  }).pipe(Effect.provide(layer));
});

it.effect("A running chat's workspace is saved and restored", () => {
  const { layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const tarball = new TextEncoder().encode("tarball");
    assert.strictEqual(yield* refusal(table.readWorkspace("chat-1")), "The chat isn't running.");
    assert.strictEqual(
      yield* refusal(table.writeWorkspace({ chatId: "chat-1", content: tarball })),
      "The chat isn't running.",
    );
    yield* table.ensure({ chatId: "chat-1", chat: Fixture.chat() });
    yield* table.writeWorkspace({ chatId: "chat-1", content: tarball });
    assert.deepStrictEqual(yield* table.readWorkspace("chat-1"), tarball);
  }).pipe(Effect.provide(layer));
});

it.effect("Inventory shows capacity and observed VM state without exposing agent setup", () => {
  const { layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* table.ensure({ chatId: "private-chat", chat: Fixture.chat() });
    const first = yield* table.inventory;
    assert.deepStrictEqual(
      first.vms.map(({ vmId, state, connections }) => [vmId, state, connections]),
      [["private-chat", "running", 0]],
    );
    yield* TestClock.adjust(IDLE);
    yield* table.stopIdle;
    assert.strictEqual((yield* table.inventory).vms[0]?.state, "stopped");
    yield* table.remove("private-chat");
    assert.deepStrictEqual((yield* table.inventory).vms, []);
  }).pipe(Effect.provide(layer));
});
