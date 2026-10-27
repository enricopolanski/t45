import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class PortProbeError extends Schema.TaggedError<PortProbeError>()("PortProbeError", {
  port: Schema.Number,
  host: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Could not probe development port ${this.port} on ${this.host}.`;
  }
}

/** Socket access for the development launcher; tests can supply availability without binding. */
export class PortProbe extends Context.Service<
  PortProbe,
  {
    /**
     * True when a TCP server can bind `{host, port}`. An unavailable IPv6 loopback is skipped.
     */
    readonly canListenOnHost: (
      port: number,
      host: string,
    ) => Effect.Effect<boolean, PortProbeError>;
  }
>()("@t45/scripts/lib/portProbe") {}

const canListenOnHost = (port: number, host: string) =>
  Effect.callback<boolean, PortProbeError>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;
    const settle = (result: Effect.Effect<boolean, PortProbeError>) => {
      if (settled) return;
      settled = true;
      resume(result);
    };

    server.unref();
    server.once("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "EADDRINUSE") {
        settle(Effect.succeed(false));
      } else if (
        host === "::1" &&
        (cause.code === "EADDRNOTAVAIL" || cause.code === "EAFNOSUPPORT")
      ) {
        settle(Effect.succeed(true));
      } else {
        settle(Effect.fail(new PortProbeError({ port, host, cause })));
      }
    });
    server.once("listening", () => {
      server.close(() => settle(Effect.succeed(true)));
    });
    server.listen({ host, port });

    return Effect.sync(() => {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    });
  });

export const layer = Layer.succeed(PortProbe, { canListenOnHost });
