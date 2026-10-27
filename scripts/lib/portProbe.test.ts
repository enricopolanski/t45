import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PortProbe from "./portProbe.ts";

it.layer(PortProbe.layer)("port probe", (it) => {
  it.effect("can bind an available local port", () =>
    Effect.gen(function* () {
      const probe = yield* PortProbe.PortProbe;
      assert.equal(yield* probe.canListenOnHost(0, "127.0.0.1"), true);
    }),
  );

  it.effect("reports an occupied port", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeNet.Server, Error>((resume) => {
          const server = NodeNet.createServer();
          server.once("error", (cause) => resume(Effect.fail(cause)));
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          return Effect.sync(() => {
            if (server.listening) server.close();
          });
        }),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const probe = yield* PortProbe.PortProbe;
      assert.equal(yield* probe.canListenOnHost(address.port, "127.0.0.1"), false);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves unexpected bind errors instead of treating them as occupied ports", () =>
    Effect.gen(function* () {
      const probe = yield* PortProbe.PortProbe;
      const error = yield* probe.canListenOnHost(0, "192.0.2.1").pipe(Effect.flip);
      assert.equal(error._tag, "PortProbeError");
      assert.equal(error.host, "192.0.2.1");
      assert.equal((error.cause as NodeJS.ErrnoException).code, "EADDRNOTAVAIL");
    }),
  );
});
