// @effect-diagnostics nodeBuiltinImport:off
import * as NodeReadline from "node:readline";

class Refusal extends Error {}

export function refuse(message: string): never {
  throw new Refusal(message);
}

interface Request {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  };
}

export const serve = ({
  name,
  tools,
  call,
  failure,
}: {
  readonly name: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }>;
  readonly call: (name: string, args: Record<string, unknown>) => string | Promise<string>;
  readonly failure: string;
}) => {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  NodeReadline.createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let message: Request;
    try {
      message = JSON.parse(line) as Request;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name, version: "1.0.0" },
        });
      case "tools/list":
        return reply({ tools });
      case "tools/call":
        try {
          const text = await call(message.params?.name ?? "", message.params?.arguments ?? {});
          return reply({ content: [{ type: "text", text }] });
        } catch (error) {
          const text = error instanceof Refusal ? error.message : failure;
          return reply({ content: [{ type: "text", text }], isError: true });
        }
      case "ping":
        return reply({});
      default:
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
};
