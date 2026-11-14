// The tool programs run inside a chat's VM, where OpenCode lists their tools before the agent
// starts, and an MCP client takes only tools whose arguments are an object.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { expect, it } from "vite-plus/test";

const runtime = new URL("../dist/runtime/", import.meta.url);

it("lists every tool with an object of arguments, those without arguments too", () => {
  const programs = NodeFS.readdirSync(runtime).filter((file) => file.endsWith(".mjs"));
  expect(programs).toContain("collection-tools.mjs");
  for (const program of programs) {
    const run = NodeChildProcess.spawnSync("node", [new URL(program, runtime).pathname], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" })}\n`,
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(run.stderr);
    const { tools } = (
      JSON.parse(run.stdout.trim().split("\n")[0]!) as {
        result: { tools: ReadonlyArray<{ name: string; inputSchema: { type: string } }> };
      }
    ).result;
    for (const tool of tools)
      expect({ program, tool: tool.name, type: tool.inputSchema.type }).toEqual({
        program,
        tool: tool.name,
        type: "object",
      });
  }
});
