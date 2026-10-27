// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { ChatAttachment } from "@t45/contracts/models/Attachment";
import type { Attachment } from "@t45/contracts/models/Attachment";
import type { Refused } from "@t45/contracts/models/Chat";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Fixture from "../chats/Chats.testkit.ts";
import * as ServerConfig from "../config.ts";
import { AttachmentRepository } from "./AttachmentRepository.ts";
import * as Attachments from "./Attachments.testkit.ts";

const alice = "user-alice";
const bob = "user-bob";

const setup = Effect.gen(function* () {
  yield* Fixture.addUser(alice);
  yield* Fixture.addUser(bob);
  const agentId = yield* Fixture.addAgent("Clerk");
  const owned = (n: number, ownerUserId: string) =>
    Fixture.seedChat({ id: Fixture.testChatId(n), ownerUserId, agentId });
  const ownerless = (n: number, stepId: string) =>
    Fixture.seedChat({ id: Fixture.testChatId(n), ownerUserId: null, agentId, stepId });
  const seeded = yield* Attachments.seedStep("item-1", alice);
  return {
    seeded,
    files: yield* AttachmentRepository,
    aliceChat: yield* owned(1, alice),
    aliceOtherChat: yield* owned(2, alice),
    bobChat: yield* owned(3, bob),
    stepChat: yield* ownerless(4, seeded.stepId),
    otherStepChat: yield* ownerless(5, seeded.stepId),
  };
});

const pngUpload = {
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

const uploadText = (uploader: string) =>
  Effect.gen(function* () {
    const files = yield* AttachmentRepository;
    return yield* files.upload(
      { type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 },
      uploader,
      Stream.make(new Uint8Array([1, 2, 3])),
    );
  });

const stepFile = (stepId: string, fieldKey: string | null = null) =>
  Effect.gen(function* () {
    const files = yield* AttachmentRepository;
    const stored = yield* files.store({
      name: "w2.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([4, 2]),
      uploader: alice,
    });
    const claimed = yield* files.claimForStep({
      id: stored.id,
      actor: alice,
      stepId,
      fieldKey,
    });
    if (claimed === null) return yield* Effect.die("The step did not take its file.");
    return claimed;
  });

const sent = (file: Attachment): ChatAttachment => ({
  type: "file",
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
});

const reasonOf = (check: Effect.Effect<void, Refused>) =>
  check.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const storedFiles = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  return NodeFS.readdirSync(attachmentsDir).toSorted();
});

const storedIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly id: string }>`SELECT id FROM attachments ORDER BY id`).map(
    (row) => row.id,
  );
});

describe("AttachmentRepository", () => {
  it.effect("streams an upload to disk under a new id, as its uploader's pending file", () =>
    Effect.gen(function* () {
      const { files } = yield* setup;
      const file = yield* files.upload(
        { type: "file", name: "report.PDF", mimeType: "application/pdf", sizeBytes: 6 },
        alice,
        Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
      );
      assert.match(file.id, /\.pdf$/);
      assert.deepEqual(
        {
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          uploader: file.uploader,
          stepId: file.stepId,
          fieldKey: file.fieldKey,
        },
        {
          name: "report.PDF",
          mimeType: "application/pdf",
          sizeBytes: 6,
          uploader: alice,
          stepId: null,
          fieldKey: null,
        },
      );
      assert.deepEqual(yield* files.get(file.id), file);
      assert.deepEqual(yield* storedFiles, [file.id]);
      const path = files.path(file.id);
      assert.deepEqual(
        path === null ? null : NodeFS.readFileSync(path),
        Buffer.from([1, 2, 3, 4, 5, 6]),
      );
    }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect(
    "names a file by its last path segment without control characters, at most 200 long",
    () =>
      Effect.gen(function* () {
        const { files } = yield* setup;
        const store = (name: string) =>
          files.store({
            name,
            mimeType: "text/plain",
            bytes: new Uint8Array([1]),
            uploader: alice,
          });
        assert.equal((yield* store("C:\\scans/2025\\cu\u0007.pdf")).name, "cu.pdf");
        assert.equal((yield* store(`${"a".repeat(300)}.txt`)).name, "a".repeat(200));
        for (const name of ["..", "scans/", " . "]) {
          assert.equal((yield* Effect.flip(store(name)))._tag, "AttachmentNameError");
        }
      }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("refuses a body that differs from its declared size, reading nothing past it", () =>
    Effect.gen(function* () {
      const { files } = yield* setup;
      const short = Stream.make(new Uint8Array(3));
      const long = Stream.make(new Uint8Array(6), new Uint8Array(1)).pipe(
        Stream.concat(Stream.die("The upload read past its declared size.")),
      );
      for (const body of [short, long]) {
        const failure = yield* files.upload(pngUpload, alice, body).pipe(Effect.flip);
        assert.equal(failure._tag, "AttachmentSizeError");
      }
      assert.deepEqual(yield* storedFiles, []);
      assert.deepEqual(yield* storedIds, []);
    }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("removes the partial file when the upload is interrupted", () =>
    Effect.gen(function* () {
      const { files } = yield* setup;
      const nextChunkRequested = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array([1, 2, 3])).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(nextChunkRequested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const upload = yield* files.upload(pngUpload, alice, body).pipe(Effect.forkScoped);

      yield* Deferred.await(nextChunkRequested);
      assert.lengthOf(yield* storedFiles, 1);
      yield* Fiber.interrupt(upload);
      assert.deepEqual(yield* storedFiles, []);
    }).pipe(Effect.scoped, Effect.provide(Attachments.layer)),
  );

  it.effect(
    "refuses another member's upload, a size mismatch, a duplicate and a step file for a member",
    () =>
      Effect.gen(function* () {
        const { files, seeded, aliceChat, bobChat, stepChat } = yield* setup;
        const mine = yield* uploadText(alice);
        const step = yield* stepFile(seeded.stepId);
        const neverUploaded = "00000000-0000-4000-8000-000000000000.txt";

        assert.equal(
          yield* reasonOf(files.bindToChat(bobChat, [sent(mine)], bob)),
          "file_unavailable",
        );
        for (const list of [
          [{ ...sent(mine), sizeBytes: 4 }],
          [sent(mine), sent(mine)],
          [sent(step)],
          [{ ...sent(mine), id: neverUploaded }],
        ]) {
          assert.equal(
            yield* reasonOf(files.bindToChat(aliceChat, list, alice)),
            "file_unavailable",
          );
        }
        yield* files.bindToChat(aliceChat, [sent(mine)], alice);
        yield* files.bindToChat(stepChat, [sent(step)], null);
      }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("binds a step's file to several chats once each, and a sent file to its chat", () =>
    Effect.gen(function* () {
      const { files, seeded, aliceChat, aliceOtherChat, stepChat, otherStepChat } = yield* setup;
      const step = yield* stepFile(seeded.stepId);
      for (const chatId of [stepChat, otherStepChat, stepChat]) {
        yield* files.bindToChat(chatId, [sent(step)], null);
      }
      assert.deepEqual(yield* files.chatsHolding(step.id), [stepChat, otherStepChat].toSorted());

      const mine = yield* uploadText(alice);
      yield* files.bindToChat(aliceChat, [sent(mine)], alice);
      yield* files.bindToChat(aliceChat, [sent(mine)], alice);
      assert.equal(
        yield* reasonOf(files.bindToChat(aliceOtherChat, [sent(mine)], alice)),
        "file_unavailable",
      );
      assert.deepEqual(yield* files.boundTo(aliceChat), [mine.id]);
    }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("releases a deleted chat's files, removing those nothing else holds", () =>
    Effect.gen(function* () {
      const { files, seeded, aliceChat, stepChat, otherStepChat } = yield* setup;
      const mine = yield* uploadText(alice);
      const step = yield* stepFile(seeded.stepId);
      yield* files.bindToChat(aliceChat, [sent(mine)], alice);
      yield* files.bindToChat(stepChat, [sent(step)], null);
      yield* files.bindToChat(otherStepChat, [sent(step)], null);
      const minePath = files.path(mine.id) ?? "";
      const stepPath = files.path(step.id) ?? "";

      yield* files.release(aliceChat);
      assert.isNull(yield* files.get(mine.id));
      assert.isFalse(NodeFS.existsSync(minePath));

      yield* files.release(stepChat);
      yield* files.detach(step.id);
      assert.deepEqual(yield* files.chatsHolding(step.id), [otherStepChat]);
      assert.isTrue(NodeFS.existsSync(stepPath));
      yield* files.release(otherStepChat);
      assert.isNull(yield* files.get(step.id));
      assert.isFalse(NodeFS.existsSync(stepPath));
    }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("sweeps unheld files after a day and keeps bound and step-held ones at any age", () =>
    Effect.gen(function* () {
      const { files, seeded, aliceChat } = yield* setup;
      yield* uploadText(alice);
      const bound = yield* uploadText(alice);
      yield* files.bindToChat(aliceChat, [sent(bound)], alice);
      const held = yield* stepFile(seeded.stepId);
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      for (const entry of yield* storedFiles) {
        NodeFS.utimesSync(NodePath.join(attachmentsDir, entry), 0, 0);
      }

      yield* TestClock.adjust("25 hours");
      const fresh = yield* uploadText(alice);
      yield* files.sweep;
      const kept = [bound, held, fresh];
      assert.deepEqual(yield* storedIds, kept.map((file) => file.id).toSorted());
      assert.deepEqual(yield* storedFiles, kept.map((file) => file.id).toSorted());
    }).pipe(Effect.provide(Attachments.layer)),
  );

  it.effect("removes bytes without a row once they are a day old, keeping younger ones", () =>
    Effect.gen(function* () {
      const { files } = yield* setup;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      yield* TestClock.adjust("25 hours");
      const old = "00000000-0000-4000-8000-000000000001.txt";
      const cutShort = "00000000-0000-4000-8000-000000000002.txt.part";
      const young = "00000000-0000-4000-8000-000000000003.txt";
      for (const [entry, seconds] of [
        [old, 0],
        [cutShort, 0],
        [young, 24 * 60 * 60],
      ] as const) {
        const path = NodePath.join(attachmentsDir, entry);
        NodeFS.writeFileSync(path, "bytes");
        NodeFS.utimesSync(path, seconds, seconds);
      }

      yield* files.sweep;
      assert.deepEqual(yield* storedFiles, [young]);
    }).pipe(Effect.provide(Attachments.layer)),
  );
});
