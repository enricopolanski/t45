// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Injected tools run as plain Node programs.
import * as NodeReadline from "node:readline";
import { Authorization } from "@t45/contracts/Authorization";
import { ReportProgress } from "@t45/contracts/resources/Chats";
import { CollectionOperations } from "@t45/contracts/resources/Collections";
import { Workflows } from "@t45/contracts/resources/Workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

class Refusal extends Error {}

export function refuse(message: string): never {
  throw new Refusal(message);
}

export const apiHeaders = {
  authorization: `Bearer ${process.env.T45_TOOL_TOKEN}`,
  ...(process.env.T45_TOOL_INSTANCE ? { "x-instance-id": process.env.T45_TOOL_INSTANCE } : {}),
};
export const apiUrl = (path: string) => new URL(path, process.env.T45_SERVER_URL).toString();
const operations = Workflows.omit("workflows.watchStep")
  .add(ReportProgress)
  .merge(CollectionOperations)
  .middleware(Authorization);
const client = RpcClient.make(operations, { disableTracing: true, flatten: true });
const protocol = () =>
  RpcClient.layerProtocolHttp({
    url: apiUrl("/api/rpc"),
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(apiHeaders)),
  }).pipe(Layer.provide(RpcSerialization.layerNdjson), Layer.provide(FetchHttpClient.layer));

type OperationTag = RpcGroup.Rpcs<typeof operations>["_tag"];

/** Calls one operation; its failure comes back as the message to show the agent. */
export const callOperation = async (tag: OperationTag, payload: unknown) => {
  const result = await Effect.runPromise(
    client.pipe(
      // One call runs one operation; its exact result type doesn't matter here.
      Effect.flatMap((api): Effect.Effect<unknown, unknown> => api(tag, payload as never)),
      Effect.scoped,
      Effect.provide(protocol()),
      Effect.result,
    ),
  );
  return Result.mapError(result, (failure) =>
    failure instanceof Error ? failure.message : "The operation failed.",
  );
};

/** The API payload supplies the tool schema; bound IDs come from its execution. */
export const rpcTool = (
  name: string,
  tag: OperationTag,
  description: string,
  bound: Record<string, string> = {},
) => {
  const rpc = operations.requests.get(tag)!;
  const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
  const decodeArguments = (input: Record<string, unknown>) => {
    try {
      return decode(input);
    } catch (error) {
      return refuse(
        `The arguments don't fit the tool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const document = Schema.toJsonSchemaDocument(rpc.payloadSchema);
  const schema = document.schema;
  const inputSchema =
    schema.type === "object"
      ? {
          ...schema,
          properties: Object.fromEntries(
            Object.entries(schema.properties ?? {}).filter(([key]) => !(key in bound)),
          ),
          required: Array.isArray(schema.required)
            ? schema.required.filter((key) => !(key in bound))
            : [],
          $defs: document.definitions,
        }
      : // MCP tools take an object of arguments; an operation without a payload takes none.
        { type: "object", properties: {} };
  return {
    name,
    description,
    inputSchema,
    call: async (input: Record<string, unknown>) => {
      const result = await callOperation(tag, decodeArguments({ ...input, ...bound }));
      if (Result.isFailure(result)) refuse(result.failure);
      return JSON.stringify(result.success) ?? "Done.";
    },
  };
};

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
  failure,
}: {
  readonly name: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly call: (args: Record<string, unknown>) => string | Promise<string>;
  }>;
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
        return reply({ tools: tools.map(({ call: _call, ...tool }) => tool) });
      case "tools/call":
        try {
          const tool = tools.find((tool) => tool.name === message.params?.name);
          if (!tool) refuse("Unknown tool.");
          const text = await tool.call(message.params?.arguments ?? {});
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
