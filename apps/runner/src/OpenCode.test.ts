import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as OpenCode from "./OpenCode.ts";

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

const connect = OpenCode.connect({
  url: "http://127.0.0.1:4096",
  password: Redacted.make("secret"),
});

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

describe("OpenCode events", () => {
  it.effect("ends a stream that stops sending anything, even heartbeats", () =>
    Effect.gen(function* () {
      const { events } = yield* connect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          servingThenSilent([{ id: "evt_1", type: "server.connected", data: {} }]),
        ),
      );
      const drained = yield* events.pipe(Stream.runCount, Effect.forkChild);
      // Let the first frame arrive and the timer start before the clock moves.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("46 seconds");
      assert.strictEqual(yield* Fiber.join(drained), 1);
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
      const failure = yield* events.pipe(Stream.runDrain, Effect.flip);
      assert.strictEqual(failure._tag, "SchemaError");
    }),
  );
});

describe("OpenCode files", () => {
  it.effect("readFile returns the file's bytes as they are, asking with the VM's password", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80]);
      const asked: Array<[string, string | undefined]> = [];
      const { readFile } = yield* connect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request, url) =>
            Effect.sync(() => {
              asked.push([url.pathname, request.headers.authorization]);
              return HttpClientResponse.fromWeb(
                request,
                new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
              );
            }),
          ),
        ),
      );
      const read = yield* readFile(".t45/attached/report (2).pdf");
      assert.deepStrictEqual([...read], [...bytes]);
      assert.deepStrictEqual(asked, [
        ["/api/fs/read/.t45/attached/report%20(2).pdf", `Basic ${btoa("opencode:secret")}`],
      ]);
    }),
  );
});

describe("OpenCode answers", () => {
  const CHUNK = 1024 * 1024;
  const CAP_CHUNKS = 64;

  /** A server whose session list doesn't end, as one an agent rewrote could send. */
  const endless = () => {
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
            { headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    return { client, served };
  };

  it.effect("stops reading an answer larger than the runner reads, and fails the call", () =>
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
});
