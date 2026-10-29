import * as NodeReadline from "node:readline";

class Refusal extends Error {}

export const refuse = (message) => {
  throw new Refusal(message);
};

export const serve = ({ name, tools, call, failure }) => {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  NodeReadline.createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
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
          const text = await call(message.params?.name, message.params?.arguments ?? {});
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
