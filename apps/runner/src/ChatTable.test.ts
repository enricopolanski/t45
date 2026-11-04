import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChatTable from "./ChatTable.ts";
import * as Fixture from "./Runner.testkit.ts";

const withTable = () => {
  const chats = Fixture.makeFakeChats();
  const layer = ChatTable.layer.pipe(Layer.provide(Fixture.layerFakeChats(chats)));
  return { chats, layer };
};

/** Why the effect failed: a refusal's reason, or another error's tag. */
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("reason" in error ? String(error.reason) : error._tag)),
  );

const start = Effect.fn(function* (chatId: string) {
  const table = yield* ChatTable.ChatTable;
  yield* table.start({ chatId, chat: Fixture.chat() });
});

/** Whether requests reach the chat's VM. */
const reachable = Effect.fn(function* (chatId: string) {
  const table = yield* ChatTable.ChatTable;
  return Option.isSome(yield* table.server(chatId));
});

it.effect("Every start boots a new VM, which takes requests until T45 removes it", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    assert.isFalse(yield* reachable("chat-1"));
    yield* start("chat-1");
    yield* start("chat-1");
    assert.deepStrictEqual(chats.started, ["chat-1", "chat-1"]);
    assert.isTrue(yield* reachable("chat-1"));
    yield* table.remove("chat-1");
    assert.deepStrictEqual([...chats.vms], []);
    assert.isFalse(yield* reachable("chat-1"));
    assert.deepStrictEqual((yield* table.inventory).vms, []);
  }).pipe(Effect.provide(layer));
});

it.effect("A VM that fails to start is removed and refused, and the next start boots anew", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    chats.failStart = true;
    assert.strictEqual(yield* refusal(start("chat-1")), "The chat's sandbox could not start.");
    assert.deepStrictEqual([...chats.vms], []);
    assert.isFalse(yield* reachable("chat-1"));
    chats.failStart = false;
    yield* start("chat-1");
    assert.isTrue(yield* reachable("chat-1"));
  }).pipe(Effect.provide(layer));
});

it.effect(
  "A start T45 stops waiting for still finishes, and T45's remove then removes its VM",
  () => {
    const { chats, layer } = withTable();
    return Effect.gen(function* () {
      const table = yield* ChatTable.ChatTable;
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      chats.hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)));
      const starting = yield* start("chat-1").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const dropping = yield* Fiber.interrupt(starting).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const removing = yield* table
        .remove("chat-1")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(dropping);
      yield* Fiber.join(removing);
      assert.deepStrictEqual([...chats.vms], []);
      assert.isFalse(yield* reachable("chat-1"));
      assert.deepStrictEqual((yield* table.inventory).vms, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("A VM that could not be removed stays listed, and is removed when T45 asks again", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* start("chat-1");
    chats.failRemove = true;
    assert.strictEqual(yield* refusal(table.remove("chat-1")), "SandboxError");
    // T45's start-up sweep still finds it to remove.
    assert.deepStrictEqual(
      (yield* table.inventory).vms.map(({ vmId, state }) => [vmId, state]),
      [["chat-1", "stopped"]],
    );
    chats.failRemove = false;
    yield* table.remove("chat-1");
    assert.deepStrictEqual([...chats.vms], []);
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
    yield* start("chat-1");
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
    yield* start("chat-1");
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
    yield* start("chat-1");
    yield* table.writeWorkspace({ chatId: "chat-1", content: tarball });
    assert.deepStrictEqual(yield* table.readWorkspace("chat-1"), tarball);
  }).pipe(Effect.provide(layer));
});
