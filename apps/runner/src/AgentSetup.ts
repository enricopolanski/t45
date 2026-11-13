import { ConfigMCP } from "@opencode/schema/config/mcp";
import type { ExecutionRequest } from "@t45/contracts/resources/Runner";
import * as Schema from "effect/Schema";

const McpServers = Schema.Record(Schema.String, Schema.toEncoded(ConfigMCP.Server));
const decodeMcpServers = Schema.decodeUnknownSync(Schema.fromJsonString(McpServers));

/** What the VM holds and sends in place of the execution's tool token. */
export const TOOL_TOKEN_PLACEHOLDER = "t45-tool-token";
/** What the VM holds and sends in place of a capability's runner secret. */
export const secretPlaceholder = (name: string) => `t45-secret-${name}`;

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
  const environment = new Map<string, string>();
  /** Each secret's hosts, from the capability that declares it. */
  const secrets = new Map<string, ReadonlyArray<string>>();
  for (const capability of request.agent.capabilities) {
    merge(capabilityFiles, capability.files ?? {});
    merge(servers, capability.mcpServers ?? {});
    merge(environment, capability.environment ?? {});
    const hosts = [...(capability.hosts ?? [])].sort();
    merge(secrets, Object.fromEntries((capability.secrets ?? []).map((name) => [name, hosts])));
  }
  const bind = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/gu, (_match, key: string) => {
      if (key === "token") return TOOL_TOKEN_PLACEHOLDER;
      if (secrets.has(key)) return secretPlaceholder(key);
      const binding = request.context[key];
      if (binding === undefined) throw new Error(`Missing execution binding: ${key}`);
      return binding;
    });
  const mcpServers = decodeMcpServers(
    JSON.stringify(Object.fromEntries(servers), (_key, value: unknown) =>
      typeof value === "string" ? bind(value) : value,
    ),
  );
  return {
    ...request.agent,
    capabilityFiles: Object.fromEntries(capabilityFiles),
    mcpServers,
    environment: Object.fromEntries(
      [...environment].map(([name, value]) => [name, bind(value)] as const),
    ),
    hosts: [...new Set(request.agent.capabilities.flatMap((capability) => capability.hosts ?? []))],
    secrets,
    notes: request.agent.capabilities.flatMap((capability) => capability.note ?? []),
  };
};

export type AgentSetup = ReturnType<typeof applyCapabilities>;
