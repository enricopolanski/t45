import { ConfigMCP } from "@opencode/schema/config/mcp";
import type { ExecutionRequest } from "@t45/contracts/resources/Runner";
import * as Schema from "effect/Schema";

const McpServers = Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server));
const decodeMcpServers = Schema.decodeUnknownSync(Schema.fromJsonString(McpServers));

/** Identical shared declarations compose; conflicting declarations must never overwrite one another. */
const merge = <A>(target: Map<string, A>, declarations: Readonly<Record<string, A>>) => {
  for (const [key, value] of Object.entries(declarations)) {
    if (target.has(key) && JSON.stringify(target.get(key)) !== JSON.stringify(value))
      throw new Error(`Conflicting capability declaration: ${key}`);
    target.set(key, value);
  }
};

/** Applies dispatched declarations without a capability catalogue or capability-specific branches. */
export const applyCapabilities = (request: ExecutionRequest) => {
  const capabilityFiles = new Map<string, string>();
  const servers = new Map<string, typeof ConfigMCP.Server.Encoded>();
  for (const capability of request.agent.capabilities) {
    merge(capabilityFiles, capability.files ?? {});
    merge(servers, capability.mcpServers ?? {});
  }
  const mcpServers = decodeMcpServers(
    JSON.stringify(Object.fromEntries(servers), (_key, value: unknown) =>
      typeof value === "string"
        ? value.replace(/\{\{(\w+)\}\}/gu, (_match, key: string) => {
            const binding = request.context[key];
            if (binding === undefined) throw new Error(`Missing execution binding: ${key}`);
            return binding;
          })
        : value,
    ),
  );
  return { ...request.agent, capabilityFiles: Object.fromEntries(capabilityFiles), mcpServers };
};

export type AgentSetup = ReturnType<typeof applyCapabilities>;
