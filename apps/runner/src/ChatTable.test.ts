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
  }).pipe(Effect.provide(layer));
});

it.effect(
  "A VM that fails to start is refused and left for T45 to remove, and the next start boots anew",
  () => {
    const { chats, layer } = withTable();
    return Effect.gen(function* () {
      const table = yield* ChatTable.ChatTable;
      chats.failStart = true;
      assert.strictEqual(yield* refusal(start("chat-1")), "The chat's sandbox could not start.");
      assert.isFalse(yield* reachable("chat-1"));
      yield* table.remove("chat-1");
      assert.deepStrictEqual([...chats.vms], []);
      chats.failStart = false;
      yield* start("chat-1");
      assert.isTrue(yield* reachable("chat-1"));
    }).pipe(Effect.provide(layer));
  },
);

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
    }).pipe(Effect.provide(layer));
  },
);

it.effect("A VM that could not be removed is removed when T45 asks again", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    yield* start("chat-1");
    chats.failRemove = true;
    assert.strictEqual(yield* refusal(table.remove("chat-1")), "SandboxError");
    assert.deepStrictEqual([...chats.vms], ["chat-1"]);
    chats.failRemove = false;
    yield* table.remove("chat-1");
    assert.deepStrictEqual([...chats.vms], []);
  }).pipe(Effect.provide(layer));
});

it.effect("Files go only into a running chat", () => {
  const { chats, layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const stored = "attachments/0f8e4a52-6c1d-4b7e-9a3f-2d5c8b1e7a40.txt";
    const file = (content: Uint8Array) => ({ chatId: "chat-1", path: stored, content });
    const text = new TextEncoder().encode("CU");
    assert.strictEqual(yield* refusal(table.writeFile(file(text))), "The file could not be added.");
    yield* start("chat-1");
    yield* table.writeFile(file(text));
    assert.strictEqual(new TextDecoder().decode(chats.files.get(`chat-1:${stored}`)), "CU");
  }).pipe(Effect.provide(layer));
});

it.effect("A running chat's workspace is saved and restored", () => {
  const { layer } = withTable();
  return Effect.gen(function* () {
    const table = yield* ChatTable.ChatTable;
    const tarball = new TextEncoder().encode("tarball");
    assert.strictEqual(
      yield* refusal(table.readWorkspace("chat-1")),
      "The workspace could not be saved.",
    );
    assert.strictEqual(
      yield* refusal(table.writeWorkspace({ chatId: "chat-1", content: tarball })),
      "The workspace could not be restored.",
    );
    yield* start("chat-1");
    yield* table.writeWorkspace({ chatId: "chat-1", content: tarball });
    assert.deepStrictEqual(yield* table.readWorkspace("chat-1"), tarball);
  }).pipe(Effect.provide(layer));
});
