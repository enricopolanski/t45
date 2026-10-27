// The workflow drafting tool runs inside a chat's VM with plain Node, so it's tested as the agent
// uses it: JSON-RPC lines on stdin, answers on stdout.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

/** Lists the tools, then drafts each of `drafts`; answers the tool names and each call's text. */
const session = (drafts: ReadonlyArray<unknown>) => {
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
  const run = NodeChildProcess.spawnSync(
    "node",
    [NodePath.join(import.meta.dirname, "../image/workflow-tools.mjs")],
    { input: `${input}\n`, encoding: "utf8" },
  );
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

const step = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: `Step ${key}`,
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
        step("collect", {
          fields: [
            { key: "contract", label: "Contract", type: "file" },
            { key: "role", label: "Role", type: "select", options: ["Sales", "Support"] },
            {
              key: "devices",
              label: "Devices",
              type: "group",
              repeatable: true,
              fields: [{ key: "model", label: "Model", type: "text" }],
            },
          ],
          subSteps: [
            step("badge", {
              fields: [{ key: "photo", label: "Photo", type: "file" }],
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
    { name: " ", steps: [step("a")] },
    { name: "Empty", steps: [] },
    { name: "Twice", steps: [step("a"), step("b", { subSteps: [step("a")] })] },
    { name: "Bad key", steps: [step("has space")] },
    {
      name: "Select",
      steps: [step("a", { fields: [{ key: "s", label: "S", type: "select", options: [] }] })],
    },
    {
      name: "Deep",
      steps: [
        step("a", {
          fields: [
            {
              key: "g",
              label: "G",
              type: "group",
              fields: [
                {
                  key: "h",
                  label: "H",
                  type: "group",
                  fields: [
                    {
                      key: "i",
                      label: "I",
                      type: "group",
                      fields: [{ key: "j", label: "J", type: "text" }],
                      repeatable: false,
                    },
                  ],
                  repeatable: false,
                },
              ],
              repeatable: false,
            },
          ],
        }),
      ],
    },
  ]);
  expect(answers.map((answer) => answer.error)).toEqual([true, true, true, true, true, true]);
  expect(answers[0]?.text).toBe("The workflow needs a name.");
  expect(answers[1]?.text).toBe("Draft at least one step.");
  expect(answers[2]?.text).toContain('The key "a" is used twice');
  expect(answers[3]?.text).toContain("a key is 1 to 64 letters");
  expect(answers[4]?.text).toContain("a select needs options");
  expect(answers[5]?.text).toContain("a group inside a group holds no group");
});
