// The workflow drafting tool runs inside a chat's VM with plain Node, so it's tested as the agent
// uses it: JSON-RPC lines on stdin, answers on stdout.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

/** Lists the tools, then drafts each of `drafts`; answers the tool names and each call's text. */
const session = (drafts: ReadonlyArray<unknown>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-tools-"));
  const runtime = NodePath.join(root, "runtime");
  // Run with only injected assets, outside the checkout's dependency tree.
  NodeFS.cpSync(new URL("../../dist/runtime/", import.meta.url), runtime, { recursive: true });
  const tool = NodePath.join(runtime, "workflow-tools.mjs");
  const input = [
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    ...drafts.map((args, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "draft", arguments: args },
    })),
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const run = NodeChildProcess.spawnSync("node", [tool], {
    cwd: root,
    input: `${input}\n`,
    encoding: "utf8",
  });
  NodeFS.rmSync(root, { recursive: true, force: true });
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
  return { tools, answers };
};

const step = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `step-${name}`,
  name,
  instructions: "",
  fields: [],
  subSteps: [],
  ...extra,
});

it("drafts a workflow whose steps and fields T45 would save", () => {
  const { tools, answers } = session([
    {
      name: "Onboarding",
      steps: [
        step("GDI", {
          fields: [
            { id: "field-ve", label: "VE", type: "text" },
            { id: "field-role", label: "Role", type: "select", options: ["Sales", "Support"] },
            { id: "field-signed", label: "Contract signed", type: "boolean" },
            {
              id: "field-devices",
              label: "Devices",
              type: "group",
              repeatable: true,
              fields: [{ id: "field-model", label: "Model", type: "text" }],
            },
          ],
          subSteps: [
            step("PIM", {
              fields: [{ id: "field-photo", label: "Photo", type: "file" }],
            }),
          ],
        }),
        step("welcome"),
      ],
    },
  ]);
  expect(tools).toEqual(["draft"]);
  expect(answers[0]?.error).toBe(false);
  expect(answers[0]?.text).toContain('Drafted "Onboarding"');
});

it("refuses a draft T45 would refuse, saying what to fix", () => {
  const { answers } = session([
    { name: " ", steps: [step("step-a")] },
    { name: "Invalid id", steps: [step("step-a", { id: "bad" })] },
    {
      name: "Select",
      steps: [
        step("step-a", {
          fields: [{ id: "field-select", label: "S", type: "select", options: [] }],
        }),
      ],
    },
    {
      name: "Invalid boolean",
      steps: [
        step("step-a", {
          fields: [
            {
              id: "field-signed",
              label: "Signed off",
              type: "yes_no",
            },
          ],
        }),
      ],
    },
  ]);
  expect(answers.map((answer) => answer.error)).toEqual([true, true, true, true]);
  expect(answers.every((answer) => answer.text.includes("Fix the draft and try again."))).toBe(
    true,
  );
});
