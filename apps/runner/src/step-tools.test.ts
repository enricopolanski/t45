// The step tools run inside a chat's VM with plain Node, so they're tested as the agent uses
// them: JSON-RPC lines on stdin, the replies T45 reads back on stdout.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

/**
 * Lists the tools, then makes each call in a working folder holding summary.txt, next to a
 * secret.txt outside it; answers the tools listed, each call's reply, and the folder.
 */
const session = (calls: ReadonlyArray<readonly [string, unknown]>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "step-tools-"));
  const work = NodePath.join(root, "work");
  NodeFS.mkdirSync(work);
  NodeFS.writeFileSync(NodePath.join(work, "summary.txt"), "the summary");
  NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "not the agent's");
  const input = [
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    ...calls.map(([name, args], index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name, arguments: args },
    })),
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const run = NodeChildProcess.spawnSync(
    "node",
    [NodePath.join(import.meta.dirname, "../image/step-tools.mjs")],
    { input: `${input}\n`, env: { ...process.env, T45_WORK_DIR: work }, encoding: "utf8" },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr);
  const replies = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
  const tools = ((replies[0]?.result.tools ?? []) as Array<{ name: string }>).map(
    (tool) => tool.name,
  );
  const answers = replies.slice(1).map((reply) => ({
    error: reply.result.isError === true,
    text: (reply.result.content as Array<{ text: string }>)[0]?.text ?? "",
  }));
  return { tools, answers, work };
};

it("takes every call without knowing the step, which T45 checks as it applies the call", () => {
  const calls = [
    ["set_field", { fieldKey: "gross", value: "a lot" }],
    ["comment", { body: "Halfway there." }],
    ["done", {}],
    ["give_up", { note: "The scan is unreadable." }],
  ] as const;
  const { tools, answers } = session(calls);
  expect(tools).toEqual(["set_field", "comment", "attach", "done", "give_up"]);
  expect(answers.map((answer) => JSON.parse(answer.text))).toEqual(calls.map(() => ({ ok: true })));
});

it("attaches a snapshot of a file in the working folder, and refuses one outside it", () => {
  const { answers, work } = session([
    ["attach", { path: "../secret.txt" }],
    ["attach", { path: "summary.txt", fieldKey: "cu" }],
  ]);
  expect(answers[0]).toEqual({ error: true, text: "The file must be in your working folder." });
  const attached = JSON.parse(answers[1]?.text ?? "") as {
    ok: boolean;
    name: string;
    file: string;
  };
  expect(attached).toMatchObject({ ok: true, name: "summary.txt" });
  expect(attached.file).toMatch(/^\.t45\/attached\/[0-9a-f-]{36}$/u);
  expect(NodeFS.readFileSync(NodePath.join(work, attached.file), "utf8")).toBe("the summary");
});
