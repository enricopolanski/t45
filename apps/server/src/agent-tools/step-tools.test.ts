// The step tools run inside a chat's VM with plain Node, so they're tested as the agent uses
// them: JSON-RPC lines on stdin, server operation replies returned on stdout.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

/**
 * Runs the injected tools against saved server replies, outside the checkout dependency tree.
 */
const session = (
  calls: ReadonlyArray<{
    name: string;
    input: Record<string, unknown>;
    text: string;
    isError: boolean;
  }>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "step-tools-"));
  const work = NodePath.join(root, "work");
  const runtime = NodePath.join(root, "runtime");
  // Run with only injected assets, outside the checkout's dependency tree.
  NodeFS.cpSync(new URL("../../dist/runtime/", import.meta.url), runtime, { recursive: true });
  const tool = NodePath.join(runtime, "step-tools.mjs");
  NodeFS.mkdirSync(work);
  NodeFS.mkdirSync(NodePath.join(work, ".t45/replies"), { recursive: true });
  const requests = calls.map((call, index) => ({
    ...call,
    input: {
      ...call.input,
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    },
  }));
  for (const request of requests) {
    NodeFS.writeFileSync(
      NodePath.join(work, `.t45/replies/${request.input.requestId}.json`),
      JSON.stringify({
        call: { tool: `step_${request.name}`, input: request.input },
        text: request.text,
        isError: request.isError,
      }),
    );
  }
  const input = [
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    ...requests.map(({ name, input }, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name, arguments: input },
    })),
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const run = NodeChildProcess.spawnSync("node", [tool], {
    cwd: work,
    input: `${input}\n`,
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr);
  const replies = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
    // Concurrent tool calls can reply in any order.
    .sort((a, b) => a.id - b.id);
  const tools = ((replies[0]?.result.tools ?? []) as Array<{ name: string }>).map(
    (tool) => tool.name,
  );
  const answers = replies.slice(1).map((reply) => ({
    error: reply.result.isError === true,
    text: (reply.result.content as Array<{ text: string }>)[0]?.text ?? "",
  }));
  NodeFS.rmSync(root, { recursive: true, force: true });
  return { tools, answers };
};

it("returns the server's field and comment results", () => {
  const { tools, answers } = session([
    {
      name: "set_field",
      input: { fieldKey: "gross", value: 42 },
      text: '{"value":42}',
      isError: false,
    },
    {
      name: "comment",
      input: { body: "Halfway there." },
      text: '{"body":"Halfway there."}',
      isError: false,
    },
  ]);
  expect(tools).toEqual(["set_field", "comment", "attach"]);
  expect(answers).toEqual([
    { error: false, text: '{"value":42}' },
    { error: false, text: '{"body":"Halfway there."}' },
  ]);
});

it("returns attachment results and refusals from the server", () => {
  const { answers } = session([
    {
      name: "attach",
      input: { path: "../secret.txt" },
      text: "The file must be in your working folder.",
      isError: true,
    },
    {
      name: "attach",
      input: { path: "summary.txt", fieldKey: "cu" },
      text: '{"id":"attachment-1","name":"summary.txt"}',
      isError: false,
    },
  ]);
  expect(answers).toEqual([
    { error: true, text: "The file must be in your working folder." },
    { error: false, text: '{"id":"attachment-1","name":"summary.txt"}' },
  ]);
});
