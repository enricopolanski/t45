import { assert, it } from "@effect/vitest";
import { Form, SessionMessage } from "@opencode/client/effect";
import { AuthSessionId } from "@t45/contracts/resources/Session";
import type { ChatId } from "@t45/contracts/models/Chat";
import { type Role } from "@t45/contracts/models/User";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Chats } from "@t45/contracts/resources/Chats";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcClient from "effect/rpc/RpcClient";
import * as RpcTest from "effect/rpc/RpcTest";

import { rootSessionId } from "./ChatIds.ts";
import { ChatRepository } from "./ChatRepository.ts";
import * as ChatsHandlers from "./Chats.handlers.ts";
import * as Fixture from "./Chats.testkit.ts";

const { testChatId } = Fixture;
const aliceChat = testChatId(1);
const automation = testChatId(3);

const group = Chats.middleware(Authorization);

const clientFor = (userId: string, role: Role) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      ChatsHandlers.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(
            Authorization,
            Authorization.of((effect) =>
              Effect.provideService(effect, CurrentUser, {
                sessionId: AuthSessionId.make(`session-${userId}`),
                userId,
                role,
                state: "active",
              }),
            ),
          ),
        ),
      ),
    ),
  );

const seed = Effect.gen(function* () {
  yield* Fixture.addUser("admin01", "admin");
  yield* Fixture.addUser("user-alice");
  yield* Fixture.addUser("user-bob");
  const agentId = yield* Fixture.addAgent("Clerk");
  yield* Fixture.seedChat({ id: aliceChat, ownerUserId: "user-alice", agentId });
  yield* Fixture.seedChat({ id: testChatId(2), ownerUserId: "user-bob", agentId });
  yield* Fixture.seedChat({
    id: automation,
    ownerUserId: null,
    agentId,
    stepId: "step-collect",
  });
});

const refusalsFor = (client: RpcClient.FromGroup<typeof group>, chatId: ChatId) => {
  const sessionId = rootSessionId(chatId);
  const formId = Form.ID.make("frm_asked");
  const failed = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E>) =>
    call.pipe(
      Effect.flip,
      Effect.map((error) => error._tag),
    );
  return Effect.all({
    watch: failed(client["chats.watch"]({ chatId }).pipe(Stream.runDrain)),
    getHistory: failed(
      client["chats.getHistory"]({ chatId, sessionId, before: SessionMessage.ID.make("msg_a") }),
    ),
    getMessage: failed(
      client["chats.getMessage"]({ chatId, sessionId, messageId: SessionMessage.ID.make("msg_a") }),
    ),
    send: failed(client["chats.send"]({ chatId, inputId: "input-1", text: "Hi", attachments: [] })),
    cancel: failed(client["chats.cancel"]({ chatId, inputId: "input-1" })),
    answer: failed(
      client["chats.answer"]({ chatId, sessionId, formId, answers: {}, attachments: {} }),
    ),
    dismiss: failed(client["chats.dismiss"]({ chatId, sessionId, formId })),
    stop: failed(client["chats.stop"]({ chatId })),
    compact: failed(client["chats.compact"]({ chatId })),
    rename: failed(client["chats.rename"]({ chatId, title: "Mine now" })),
    delete: failed(client["chats.delete"]({ chatId })),
  });
};

const allNotFound = {
  watch: "NotFound",
  getHistory: "NotFound",
  getMessage: "NotFound",
  send: "NotFound",
  cancel: "NotFound",
  answer: "NotFound",
  dismiss: "NotFound",
  stop: "NotFound",
  compact: "NotFound",
  rename: "NotFound",
  delete: "NotFound",
};

it.effect("answers NotFound for another person's chat, even for admins", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const [userId, role] of [
      ["user-bob", "member"],
      ["admin01", "admin"],
    ] as const) {
      const client = yield* clientFor(userId, role);
      assert.deepStrictEqual(yield* refusalsFor(client, aliceChat), allNotFound);
    }
  }).pipe(Effect.scoped, Effect.provide(Fixture.layerStore)),
);

it.effect("answers NotFound for a deleted chat, even to its owner", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* (yield* ChatRepository).markDeleted(aliceChat, "2026-10-23T09:00:00.000Z");
    const client = yield* clientFor("user-alice", "member");
    assert.deepStrictEqual(yield* refusalsFor(client, aliceChat), allNotFound);
  }).pipe(Effect.scoped, Effect.provide(Fixture.layerStore)),
);

it.effect("lets admins reach automation's chats, which members don't find", () =>
  Effect.gen(function* () {
    yield* seed;
    const member = yield* clientFor("user-alice", "member");
    assert.deepStrictEqual(yield* refusalsFor(member, automation), allNotFound);

    const admin = yield* clientFor("admin01", "admin");
    yield* admin["chats.rename"]({ chatId: automation, title: "Nightly" });
    assert.equal((yield* (yield* ChatRepository).get(automation))?.title, "Nightly");
  }).pipe(Effect.scoped, Effect.provide(Fixture.layerStore)),
);
