import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const serving = (events: ReadonlyArray<unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  );

const connect = OpenCode2Client.connect({ baseUrl: "http://127.0.0.1:4096", password: "secret" });

/** Sends `events`, then keeps the connection open without another byte, like a frozen server. */
const servingThenSilent = (events: ReadonlyArray<unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events) {
                controller.enqueue(new TextEncoder().encode(`data: ${encodeJson(event)}\n\n`));
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );

describe("OpenCode2Client events", () => {
  it.effect("fails a stream that stops sending anything, even heartbeats", () =>
    Effect.gen(function* () {
      const { events } = yield* connect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          servingThenSilent([{ id: "evt_1", type: "server.connected", data: {} }]),
        ),
      );
      const drained = yield* (yield* events).pipe(Stream.runDrain, Effect.flip, Effect.forkChild);
      // Let the first frame arrive and the timer start before the clock moves.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("46 seconds");
      const failure = yield* Fiber.join(drained);
      assert.strictEqual(failure._tag, "OpenCode2SilentStreamError");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails the stream on a frame that does not decode", () =>
    Effect.gen(function* () {
      const { events } = yield* connect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          serving([
            {
              id: "evt_1",
              created: 1,
              type: "session.hologram.projected",
              data: { sessionID: "ses_x" },
            },
          ]),
        ),
      );
      const failure = yield* (yield* events).pipe(Stream.runDrain, Effect.flip);
      assert.strictEqual(failure._tag, "SchemaError");
    }),
  );
});

describe("OpenCode2Client files", () => {
  it.effect("readFile returns the file's bytes as they are", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80]);
      const asked: Array<string> = [];
      const { readFile } = yield* OpenCode2Client.connect({
        baseUrl: "http://runner.test/chats/chat-1/opencode",
        password: "secret",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request, url) =>
            Effect.sync(() => {
              asked.push(url.pathname);
              return HttpClientResponse.fromWeb(
                request,
                new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
              );
            }),
          ),
        ),
      );
      const read = yield* readFile(".t45/attached/report (2).pdf");
      assert.deepStrictEqual([...(read ?? [])], [...bytes]);
      assert.deepStrictEqual(asked, [
        "/chats/chat-1/opencode/api/fs/read/.t45/attached/report%20(2).pdf",
      ]);
    }),
  );
});

describe("OpenCode2Client answers", () => {
  const CHUNK = 1024 * 1024;
  const CAP_CHUNKS = OpenCode2Client.RESPONSE_MAX_BYTES / CHUNK;

  /** A server whose session list doesn't end, as one an agent rewrote could send. */
  const endless = (headers: Record<string, string> = {}) => {
    const served = { chunks: 0 };
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const chunk = new Uint8Array(CHUNK).fill(32);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                served.chunks += 1;
                if (served.chunks > 4 * CAP_CHUNKS) controller.close();
                else controller.enqueue(chunk);
              },
            }),
            { headers: { "content-type": "application/json", ...headers } },
          ),
        );
      }),
    );
    return { client, served };
  };

  it.effect("stops reading an answer larger than T45 holds, and fails the call", () =>
    Effect.gen(function* () {
      const server = endless();
      const { client } = yield* connect.pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );
      const failure = yield* client.session.list().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ClientError");
      assert.isAtMost(server.served.chunks, CAP_CHUNKS + 2);
    }),
  );

  it.effect("refuses an answer that says it is too large before reading it", () =>
    Effect.gen(function* () {
      const server = endless({ "content-length": String(OpenCode2Client.RESPONSE_MAX_BYTES + 1) });
      const { client } = yield* connect.pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );
      const failure = yield* client.session.list().pipe(Effect.flip);
      assert.include(failure._tag === "ClientError" ? String(failure.cause) : "", "larger than");
      assert.isAtMost(server.served.chunks, 1);
    }),
  );
});
